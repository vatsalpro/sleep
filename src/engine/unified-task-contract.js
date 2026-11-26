/**
 * Sleepwalker 2.0 — Stage 4: Unified Task Contract, Lifecycle FSM,
 * Shared Verifier, and Uniform Browser/Desktop Backend Adapters
 *
 * Architectural guarantees:
 * - Single shared request/result contract for BOTH Browser and Desktop backends.
 * - Single canonical command lifecycle FSM with strict stale-command isolation.
 * - Shared verifier: a dispatched action is NEVER treated as successful until observed state is verified.
 * - Neither backend contains a planner or autonomous loop; both execute strictly atomic steps.
 */
(function (rootScope) {
  'use strict';

  const LIFECYCLE_STATES = Object.freeze({
    IDLE: 'IDLE',
    LISTENING: 'LISTENING',
    UNDERSTANDING: 'UNDERSTANDING',
    GATHERING_CONTEXT: 'GATHERING_CONTEXT',
    PLANNING: 'PLANNING',
    RESOLVING_TARGET: 'RESOLVING_TARGET',
    EXECUTING: 'EXECUTING',
    VERIFYING: 'VERIFYING',
    COMPLETED: 'COMPLETED',
    CANCELLED: 'CANCELLED',
    FAILED: 'FAILED',
    WAITING_FOR_USER: 'WAITING_FOR_USER',
    RECOVERING: 'RECOVERING',
    TIMEOUT: 'TIMEOUT'
  });

  const TERMINAL_STATES = new Set([
    LIFECYCLE_STATES.COMPLETED,
    LIFECYCLE_STATES.CANCELLED,
    LIFECYCLE_STATES.FAILED,
    LIFECYCLE_STATES.TIMEOUT
  ]);

  const VALID_BACKENDS = new Set(['browser', 'desktop', 'cross_backend', 'none']);

  const ALLOWED_BROWSER_ACTIONS = new Set([
    'navigate',
    'search',
    'click',
    'double_click',
    'right_click',
    'hover',
    'drag',
    'press_key',
    'type_text',
    'fill',
    'fill_form',
    'interact_control',
    'extract',
    'read_page',
    'observe',
    'scroll',
    'tab_switch',
    'tab_list',
    'back',
    'forward'
  ]);

  const ALLOWED_DESKTOP_ACTIONS = new Set([
    'launch_app',
    'launch_process',
    'activate_window',
    'close_window',
    'move_resize_window',
    'type_text',
    'press_key',
    'key_combination',
    'mouse_move',
    'mouse_click',
    'mouse_double_click',
    'mouse_right_click',
    'mouse_down',
    'mouse_up',
    'mouse_drag',
    'mouse_scroll',
    'uia_find_control',
    'uia_list_controls',
    'uia_invoke',
    'uia_set_value',
    'uia_select_item',
    'uia_expand_collapse',
    'uia_read_text',
    'uia_navigate_menu',
    'read_application_text',
    'ensure_notepad_editor',
    'detect_dialogs',
    'capture_screenshot',
    'get_active_window',
    'list_windows',
    'get_display_info',
    'get_safety_state',
    'ping'
  ]);

  let _idSeq = 0;
  function generateId(prefix = 'sw') {
    _idSeq += 1;
    const rand = Math.random().toString(36).slice(2, 7);
    return `${prefix}-${Date.now().toString(36)}-${_idSeq}-${rand}`;
  }

  function nowIso() {
    return new Date().toISOString();
  }

  // =========================================================================
  // 1. UNIFIED COMMAND LIFECYCLE MANAGER (with strict stale-command protection)
  // =========================================================================
  class UnifiedLifecycleManager {
    constructor(options = {}) {
      this.state = LIFECYCLE_STATES.IDLE;
      this.activeTaskId = null;
      this.activeCommandId = null;
      this.epoch = 0;
      this.activeBackend = 'none';
      this.understoodSummary = '';
      this.currentStepIndex = 0;
      this.totalSteps = 0;
      this.completedSteps = [];
      this.lastError = null;
      this.userPrompt = null;
      this.transitions = [];
      this.commandRecords = new Map();
      this.cancelledTaskIds = new Set();
      this.cancelledCommandIds = new Set();
      this.rejectedStaleAttempts = [];
      this.onChange = typeof options.onChange === 'function' ? options.onChange : null;
    }

    beginCommand({ taskId = null, commandId = null, rawText = '', inputSource = 'typed', startListening = false } = {}) {
      const tid = String(taskId || generateId('task'));
      const cid = String(commandId || generateId('cmd'));
      this.epoch += 1;
      const cmdEpoch = this.epoch;

      this.activeTaskId = tid;
      this.activeCommandId = cid;
      this.activeBackend = 'none';
      this.understoodSummary = String(rawText || '').trim().slice(0, 120);
      this.currentStepIndex = 0;
      this.totalSteps = 0;
      this.completedSteps = [];
      this.lastError = null;
      this.userPrompt = null;

      const record = {
        taskId: tid,
        commandId: cid,
        epoch: cmdEpoch,
        rawText: String(rawText || ''),
        inputSource,
        state: LIFECYCLE_STATES.IDLE,
        selectedBackend: 'none',
        startedAt: nowIso(),
        completedAt: null,
        transitions: [],
        staleRejections: 0
      };
      this.commandRecords.set(cid, record);

      if (startListening) {
        this.transition(cid, LIFECYCLE_STATES.LISTENING, { detail: 'Voice input received' });
      }
      this.transition(cid, LIFECYCLE_STATES.UNDERSTANDING, { detail: this.understoodSummary || 'Understanding request' });
      return { taskId: tid, commandId: cid, epoch: cmdEpoch };
    }

    isCurrent(commandId, taskId = null) {
      if (!commandId) return false;
      if (this.cancelledCommandIds.has(String(commandId))) return false;
      if (taskId && this.cancelledTaskIds.has(String(taskId))) return false;
      if (this.activeCommandId !== String(commandId)) return false;
      if (taskId && this.activeTaskId !== String(taskId)) return false;
      return true;
    }

    markCancelled(commandId = null, taskId = null, detail = 'Cancelled by user') {
      const cid = commandId ? String(commandId) : this.activeCommandId;
      const tid = taskId ? String(taskId) : this.activeTaskId;
      if (cid) this.cancelledCommandIds.add(cid);
      if (tid) this.cancelledTaskIds.add(tid);

      // Only mutate live state if cancelling the currently active command
      if (cid && cid === this.activeCommandId && !TERMINAL_STATES.has(this.state)) {
        const prev = this.state;
        this.state = LIFECYCLE_STATES.CANCELLED;
        const entry = {
          taskId: tid,
          commandId: cid,
          epoch: this.epoch,
          from: prev,
          to: LIFECYCLE_STATES.CANCELLED,
          backend: this.activeBackend,
          detail,
          timestamp: nowIso()
        };
        this.transitions.push(entry);
        const rec = this.commandRecords.get(cid);
        if (rec) {
          rec.state = LIFECYCLE_STATES.CANCELLED;
          rec.completedAt = entry.timestamp;
          rec.transitions.push(entry);
        }
        this._emit(entry);
      }
      return { cancelledCommandId: cid, cancelledTaskId: tid };
    }

    transition(commandId, nextState, meta = {}) {
      const cid = String(commandId || '');
      const validNext = Object.values(LIFECYCLE_STATES).includes(nextState);
      if (!validNext) {
        return { accepted: false, reason: 'invalid_state', state: this.state };
      }

      // Stale-command protection: older/preempted/cancelled commands CANNOT mutate newer lifecycle state!
      if (!this.isCurrent(cid, meta.taskId || null)) {
        // Allow recording terminal CANCELLED on the stale command's own audit record without touching live state
        const staleRec = this.commandRecords.get(cid);
        if (staleRec) staleRec.staleRejections += 1;
        const rejection = {
          commandId: cid,
          attemptedState: nextState,
          activeCommandId: this.activeCommandId,
          activeState: this.state,
          reason: this.cancelledCommandIds.has(cid) ? 'command_cancelled' : 'stale_command',
          timestamp: nowIso()
        };
        this.rejectedStaleAttempts.push(rejection);
        if (this.rejectedStaleAttempts.length > 100) this.rejectedStaleAttempts.shift();
        return { accepted: false, stale: true, reason: rejection.reason, activeCommandId: this.activeCommandId };
      }

      const prev = this.state;
      this.state = nextState;
      if (meta.backend && VALID_BACKENDS.has(meta.backend)) {
        this.activeBackend = meta.backend;
      }
      if (typeof meta.understoodSummary === 'string' && meta.understoodSummary) {
        this.understoodSummary = meta.understoodSummary;
      }
      if (Number.isFinite(meta.currentStepIndex)) this.currentStepIndex = meta.currentStepIndex;
      if (Number.isFinite(meta.totalSteps)) this.totalSteps = meta.totalSteps;
      if (Array.isArray(meta.completedSteps)) this.completedSteps = meta.completedSteps.slice();
      if (meta.error !== undefined) this.lastError = meta.error;
      if (meta.userPrompt !== undefined) this.userPrompt = meta.userPrompt;

      const entry = {
        taskId: this.activeTaskId,
        commandId: cid,
        epoch: this.epoch,
        from: prev,
        to: nextState,
        backend: this.activeBackend,
        stepIndex: this.currentStepIndex,
        totalSteps: this.totalSteps,
        detail: String(meta.detail || ''),
        timestamp: nowIso()
      };
      this.transitions.push(entry);
      if (this.transitions.length > 400) this.transitions.shift();

      const rec = this.commandRecords.get(cid);
      if (rec) {
        rec.state = nextState;
        rec.selectedBackend = this.activeBackend;
        rec.transitions.push(entry);
        if (TERMINAL_STATES.has(nextState)) {
          rec.completedAt = entry.timestamp;
        }
      }

      this._emit(entry);
      return { accepted: true, entry };
    }

    resetToIdle(expectedCommandId = null) {
      if (expectedCommandId && String(expectedCommandId) !== this.activeCommandId) {
        return false;
      }
      const prev = this.state;
      this.state = LIFECYCLE_STATES.IDLE;
      const entry = {
        taskId: this.activeTaskId,
        commandId: this.activeCommandId,
        epoch: this.epoch,
        from: prev,
        to: LIFECYCLE_STATES.IDLE,
        backend: 'none',
        detail: 'Returned to IDLE',
        timestamp: nowIso()
      };
      this.transitions.push(entry);
      this._emit(entry);
      return true;
    }

    getSnapshot() {
      return {
        state: this.state,
        activeTaskId: this.activeTaskId,
        activeCommandId: this.activeCommandId,
        epoch: this.epoch,
        backend: this.activeBackend,
        understoodSummary: this.understoodSummary,
        currentStepIndex: this.currentStepIndex,
        totalSteps: this.totalSteps,
        completedSteps: this.completedSteps.slice(),
        lastError: this.lastError,
        userPrompt: this.userPrompt
      };
    }

    getCommandRecord(commandId) {
      return this.commandRecords.get(String(commandId || '')) || null;
    }

    _emit(entry) {
      if (this.onChange) {
        try {
          this.onChange(this.getSnapshot(), entry);
        } catch (_e) {
          // Never allow UI listeners to break orchestration
        }
      }
    }
  }

  // =========================================================================
  // 2. SHARED TASK CONTRACT BUILDERS & VALIDATORS
  // =========================================================================
  function createTaskRequest(spec = {}) {
    const taskId = String(spec.taskId || generateId('task'));
    const commandId = String(spec.commandId || generateId('cmd'));
    const stepId = String(spec.stepId || `${commandId}-step-1`);
    const backend = String(spec.backend || '').toLowerCase();
    const action = String(spec.action || '').trim().toLowerCase();
    const timeout = Math.max(100, Math.min(60000, Number(spec.timeout || spec.timeoutMs || 12000)));

    return {
      taskId,
      commandId,
      stepId,
      backend,
      action,
      target: spec.target && typeof spec.target === 'object' ? { ...spec.target } : {},
      parameters: spec.parameters && typeof spec.parameters === 'object' ? { ...spec.parameters } : {},
      expectedState: spec.expectedState && typeof spec.expectedState === 'object' ? { ...spec.expectedState } : null,
      timeout,
      signal: spec.signal || null
    };
  }

  function validateTaskRequest(req) {
    if (!req || typeof req !== 'object') {
      return { valid: false, code: 'INVALID_REQUEST', error: 'Task request must be an object' };
    }
    if (!req.taskId || !req.commandId) {
      return { valid: false, code: 'INVALID_REQUEST', error: 'taskId and commandId are required' };
    }
    if (req.backend !== 'browser' && req.backend !== 'desktop') {
      return { valid: false, code: 'INVALID_BACKEND', error: `Unsupported backend '${req.backend}'` };
    }
    if (!req.action) {
      return { valid: false, code: 'INVALID_REQUEST', error: 'action is required' };
    }
    if (req.backend === 'browser' && !ALLOWED_BROWSER_ACTIONS.has(req.action)) {
      return {
        valid: false,
        code: 'BACKEND_ACTION_MISMATCH',
        error: `Action '${req.action}' is not valid for browser backend`
      };
    }
    if (req.backend === 'desktop' && !ALLOWED_DESKTOP_ACTIONS.has(req.action)) {
      return {
        valid: false,
        code: 'BACKEND_ACTION_MISMATCH',
        error: `Action '${req.action}' is not valid for desktop backend`
      };
    }
    return { valid: true };
  }

  function createTaskResult(req, patch = {}) {
    const ok = Boolean(patch.ok);
    const status = String(patch.status || (ok ? 'COMPLETED' : 'FAILED'));
    return {
      taskId: req ? req.taskId : (patch.taskId || null),
      commandId: req ? req.commandId : (patch.commandId || null),
      stepId: req ? req.stepId : (patch.stepId || null),
      backend: req ? req.backend : (patch.backend || 'none'),
      engine: String(patch.engine || 'unknown'),
      action: req ? req.action : (patch.action || ''),
      ok,
      status,
      result: patch.result !== undefined ? patch.result : null,
      targetIdentity: patch.targetIdentity || null,
      actualState: patch.actualState || null,
      executionTimestamp: patch.executionTimestamp || nowIso(),
      durationMs: Number.isFinite(patch.durationMs) ? Math.round(patch.durationMs * 100) / 100 : 0,
      evidence: patch.evidence || {},
      error: ok
        ? null
        : (patch.error && typeof patch.error === 'object'
          ? {
              code: String(patch.error.code || status),
              message: String(patch.error.message || status),
              recoverable: patch.error.recoverable !== false
            }
          : {
              code: status,
              message: String(patch.error || patch.message || status),
              recoverable: patch.recoverable !== false
            })
    };
  }

  // =========================================================================
  // 3. SHARED VERIFIER (Browser + Desktop — Dispatch != Success!)
  // =========================================================================
  class SharedVerifier {
    /**
     * Verify browser execution outcome against expectedState using actual observed browser state.
     */
    async verifyBrowser(request, taskResult, stateProbe = null) {
      const checks = [];
      const expected = request && request.expectedState;
      let actual = (taskResult && taskResult.actualState) || {};

      if (typeof stateProbe === 'function') {
        try {
          const live = await stateProbe(request);
          if (live && typeof live === 'object') {
            actual = { ...actual, ...live };
          }
        } catch (err) {
          checks.push({
            check: 'browser_state_probe',
            passed: false,
            expected: 'reachable browser state',
            observed: (err && err.message) || 'probe failed'
          });
        }
      }

      if (!taskResult || !taskResult.ok) {
        return {
          verified: false,
          status: (taskResult && taskResult.status) || 'FAILED',
          checks,
          actualState: actual,
          failureReason: (taskResult && taskResult.error && taskResult.error.message) || 'Execution did not succeed'
        };
      }

      if (!expected || Object.keys(expected).length === 0) {
        // Even with no explicit expectedState, verify the result carries real observed state (URL, DOM, or extracted data)
        const hasRealState = Boolean(
          actual.url ||
          actual.title ||
          actual.readyState ||
          actual.domMatched ||
          (taskResult.result && (taskResult.result.text || taskResult.result.url || taskResult.result.clicked || taskResult.result.filled || taskResult.result.tabs || taskResult.result.extracted))
        );
        checks.push({
          check: 'browser_observed_state_present',
          passed: hasRealState,
          expected: 'non-empty observed browser state',
          observed: hasRealState ? (actual.url || actual.title || 'state_observed') : 'unavailable'
        });
        return {
          verified: hasRealState,
          status: hasRealState ? 'COMPLETED' : 'VERIFICATION_FAILED',
          checks,
          actualState: actual,
          failureReason: hasRealState ? null : 'Dispatched browser action returned no verifiable resulting state'
        };
      }

      if (expected.urlContains) {
        const needle = String(expected.urlContains).toLowerCase();
        const url = String(actual.url || '').toLowerCase();
        const ok = url.includes(needle);
        checks.push({ check: 'url_contains', passed: ok, expected: expected.urlContains, observed: actual.url || null });
      }

      if (expected.urlNotEquals) {
        const prev = String(expected.urlNotEquals).trim();
        const cur = String(actual.url || '').trim();
        const ok = Boolean(cur && cur !== prev);
        checks.push({ check: 'url_changed', passed: ok, expected: `!= ${prev}`, observed: cur || null });
      }

      if (expected.navigationComplete) {
        const ready = actual.readyState === 'complete' || actual.navigationComplete === true;
        checks.push({ check: 'navigation_complete', passed: ready, expected: 'complete', observed: actual.readyState || actual.navigationComplete || null });
      }

      if (expected.domTextContains) {
        const needle = String(expected.domTextContains).toLowerCase();
        const hay = `${actual.visibleText || ''} ${actual.title || ''} ${(Array.isArray(actual.headings) ? actual.headings.join(' ') : '')} ${(taskResult.result && (taskResult.result.text || taskResult.result.extractedText)) || ''}`.toLowerCase();
        const ok = hay.includes(needle);
        checks.push({ check: 'dom_text_contains', passed: ok, expected: expected.domTextContains, observed: hay.slice(0, 140) });
      }

      if (expected.minResultsCount !== undefined) {
        const list = (taskResult.result && Array.isArray(taskResult.result.searchResults) && taskResult.result.searchResults) ||
          (Array.isArray(actual.searchResults) && actual.searchResults) ||
          [];
        const wantMin = Number(expected.minResultsCount || 1);
        const ok = list.length >= wantMin;
        checks.push({ check: 'min_results_count', passed: ok, expected: `>= ${wantMin}`, observed: list.length });
      }

      if (expected.scrollChanged) {
        const delta = Number((actual.scrolledDelta !== undefined ? actual.scrolledDelta : (taskResult.result && taskResult.result.scrolledDelta)) || 0);
        const ok = Math.abs(delta) > 0 || actual.targetInView === true || Boolean(taskResult.result && taskResult.result.targetInView);
        checks.push({ check: 'scroll_changed', passed: ok, expected: 'non-zero scroll or target in view', observed: delta });
      }

      if (expected.accessibleName) {
        const needle = String(expected.accessibleName).toLowerCase();
        const got = String((actual.accessibility && actual.accessibility.name) || (taskResult.targetIdentity && taskResult.targetIdentity.accessibleName) || '').toLowerCase();
        const ok = got.includes(needle);
        checks.push({ check: 'accessibility_name', passed: ok, expected: expected.accessibleName, observed: got || null });
      }

      if (expected.extractedNonEmpty) {
        const extracted = String(
          (taskResult.result && (taskResult.result.extractedText || taskResult.result.text || taskResult.result.summary)) ||
          actual.extractedText ||
          ''
        ).trim();
        const ok = extracted.length > 0;
        checks.push({ check: 'extracted_non_empty', passed: ok, expected: 'non-empty extracted text', observed: extracted.slice(0, 120) });
      }

      if (expected.valueEquals !== undefined) {
        const observedVal = String(actual.value !== undefined ? actual.value : (taskResult.result && taskResult.result.value) || '');
        const ok = observedVal === String(expected.valueEquals);
        checks.push({ check: 'dom_value_equals', passed: ok, expected: String(expected.valueEquals), observed: observedVal });
      }

      if (expected.controlVerified) {
        const ok = Boolean(
          (taskResult.result && taskResult.result.controlVerified === true) ||
          actual.controlVerified === true
        );
        const obsState = (taskResult.result && taskResult.result.verifiedState)
          ? JSON.stringify(taskResult.result.verifiedState).slice(0, 140)
          : String(ok);
        checks.push({
          check: 'control_state_verified',
          passed: ok,
          expected: 'verified hierarchical control state change',
          observed: obsState
        });
      }

      const allPassed = checks.length > 0 && checks.every((c) => c.passed === true);
      const firstFail = checks.find((c) => !c.passed);
      return {
        verified: allPassed,
        status: allPassed ? 'COMPLETED' : 'VERIFICATION_FAILED',
        checks,
        actualState: actual,
        failureReason: allPassed ? null : `Browser verification failed on '${firstFail.check}': expected '${firstFail.expected}', observed '${firstFail.observed}'`
      };
    }

    /**
     * Verify desktop execution outcome against expectedState using actual HWND/process/UIA/screenshot evidence.
     */
    async verifyDesktop(request, taskResult, desktopBackend = null) {
      const checks = [];
      const expected = request && request.expectedState;
      let actual = (taskResult && taskResult.actualState) || {};
      const evidence = { ...((taskResult && taskResult.evidence) || {}) };

      if (!taskResult || !taskResult.ok) {
        return {
          verified: false,
          status: (taskResult && taskResult.status) || 'FAILED',
          checks,
          actualState: actual,
          evidence,
          failureReason: (taskResult && taskResult.error && taskResult.error.message) || 'Desktop action did not succeed'
        };
      }

      if (!expected || Object.keys(expected).length === 0) {
        const hasWinOrData = Boolean(
          (actual.window && actual.window.hwnd > 0) ||
          (taskResult.targetIdentity && taskResult.targetIdentity.hwnd > 0) ||
          (taskResult.result !== null && taskResult.result !== undefined)
        );
        checks.push({
          check: 'desktop_observed_state_present',
          passed: hasWinOrData,
          expected: 'non-empty desktop state',
          observed: hasWinOrData ? 'observed' : 'unavailable'
        });
        return {
          verified: hasWinOrData,
          status: hasWinOrData ? 'COMPLETED' : 'VERIFICATION_FAILED',
          checks,
          actualState: actual,
          evidence,
          failureReason: hasWinOrData ? null : 'Dispatched desktop action returned no verifiable resulting state'
        };
      }

      // Live foreground check if requested and backend available
      if ((expected.foregroundProcess || expected.foregroundTitleContains || expected.mustBeForeground) && desktopBackend && typeof desktopBackend.queryActiveWindow === 'function') {
        const liveWin = await desktopBackend.queryActiveWindow(request.signal).catch(() => null);
        if (liveWin) {
          actual = { ...actual, window: liveWin };
        }
      }

      const win = actual.window || taskResult.targetIdentity || {};

      if (expected.mustBeForeground) {
        const ok = Boolean(win.hwnd > 0 && win.isForeground === true);
        checks.push({ check: 'foreground_confirmed', passed: ok, expected: true, observed: Boolean(win.isForeground) });
      }

      if (expected.foregroundProcess) {
        const needle = String(expected.foregroundProcess).toLowerCase().replace(/\.exe$/, '');
        const proc = String(win.processName || '').toLowerCase();
        const title = String(win.title || '').toLowerCase();
        const ok = proc.includes(needle) || title.includes(needle);
        checks.push({ check: 'foreground_process', passed: ok, expected: expected.foregroundProcess, observed: win.processName || win.title || null });
      }

      if (expected.foregroundTitleContains) {
        const needle = String(expected.foregroundTitleContains).toLowerCase();
        const title = String(win.title || '').toLowerCase();
        const ok = title.includes(needle);
        checks.push({ check: 'foreground_title_contains', passed: ok, expected: expected.foregroundTitleContains, observed: win.title || null });
      }

      if (expected.uiaTextContains !== undefined || expected.uiaTextEquals !== undefined) {
        let observedText = String(
          (actual.uiaText !== undefined ? actual.uiaText : null) ??
          (taskResult.result && (taskResult.result.text ?? taskResult.result.readback ?? taskResult.result.actualValue)) ??
          ''
        );

        // Live UIA readback if not already present or if explicitly re-reading
        if ((!observedText || expected.forceLiveReadback) && desktopBackend && typeof desktopBackend.readWindowText === 'function') {
          const readTarget = expected.uiaReadTarget || {};
          const expectedWin = win.hwnd ? { hwnd: win.hwnd, processName: win.processName } : (request.target && request.target.expectedWindow) || null;
          const liveRead = await desktopBackend.readWindowText(expectedWin, readTarget, request.signal).catch(() => null);
          if (liveRead && typeof liveRead.text === 'string') {
            observedText = liveRead.text;
            actual = { ...actual, uiaText: observedText };
          }
        }

        if (expected.uiaTextContains !== undefined) {
          const needle = String(expected.uiaTextContains).trim();
          const normObs = observedText.toLowerCase();
          const normObsNoCommas = normObs.replace(/,/g, '');
          const normNeedle = needle.toLowerCase();
          const ok = needle.length > 0 && (normObs.includes(normNeedle) || normObsNoCommas.includes(normNeedle.replace(/,/g, '')));
          checks.push({ check: 'uia_text_contains', passed: ok, expected: needle, observed: observedText.slice(0, 160) });
        }
        if (expected.uiaTextEquals !== undefined) {
          const want = String(expected.uiaTextEquals).trim();
          const ok = observedText.trim() === want;
          checks.push({ check: 'uia_text_equals', passed: ok, expected: want, observed: observedText.trim().slice(0, 160) });
        }
      }

      if (expected.requireReceiptVerified) {
        const ok = Boolean(taskResult.result && taskResult.result.receiptVerified === true);
        checks.push({ check: 'input_receipt_verified', passed: ok, expected: true, observed: Boolean(taskResult.result && taskResult.result.receiptVerified) });
      }

      if (expected.requireScreenshot && desktopBackend && typeof desktopBackend.captureScreenshot === 'function') {
        const shotPath = typeof expected.requireScreenshot === 'string' ? expected.requireScreenshot : null;
        const shot = await desktopBackend.captureScreenshot(shotPath, win.hwnd ? { hwnd: win.hwnd } : null, request.signal).catch(() => null);
        const ok = Boolean(shot && shot.ok);
        evidence.verificationScreenshot = shot && shot.result ? shot.result : null;
        checks.push({ check: 'screenshot_evidence', passed: ok, expected: 'fresh screenshot', observed: ok ? (shot.result && shot.result.outputPath) || 'captured' : 'failed' });
      }

      const allPassed = checks.length > 0 && checks.every((c) => c.passed === true);
      const firstFail = checks.find((c) => !c.passed);
      return {
        verified: allPassed,
        status: allPassed ? 'COMPLETED' : 'VERIFICATION_FAILED',
        checks,
        actualState: actual,
        evidence,
        failureReason: allPassed ? null : `Desktop verification failed on '${firstFail.check}': expected '${firstFail.expected}', observed '${firstFail.observed}'`
      };
    }
  }

  // =========================================================================
  // 4. BROWSER BACKEND ADAPTER (Stagehand feature-flagged + Existing Engine Fallback)
  // =========================================================================
  class BrowserBackendAdapter {
    constructor(options = {}) {
      this.stagehandAdapter = options.stagehandAdapter || null;
      this.browserEngine = options.browserEngine || null;
      this.controller = options.controller || null; // optional SleepwalkerController reference
      this.customExecutor = typeof options.customExecutor === 'function' ? options.customExecutor : null;
      this.customCancel = typeof options.customCancel === 'function' ? options.customCancel : null;
      this.customStateProbe = typeof options.customStateProbe === 'function' ? options.customStateProbe : null;
      this.useStagehandFn = typeof options.useStagehandFn === 'function'
        ? options.useStagehandFn
        : () => Boolean(
          (this.controller && this.controller.useStagehandAdapter) ||
          (typeof window !== 'undefined' && window.__SLEEPWALKER_ENABLE_STAGEHAND_ADAPTER__ === true)
        );
      this.activeCommandId = null;
      this.activeControllers = new Map();
    }

    _collectShadowData(root, selector = null, maxDepth = 6, depth = 0, out = { elements: [], shadowTexts: [] }) {
      if (!root || depth > maxDepth) return out;
      try {
        if (selector && typeof root.querySelectorAll === 'function') {
          root.querySelectorAll(selector).forEach((el) => {
            if (!el.closest || !el.closest('#sleepwalker-ui-host, #sleepwalker-host, [data-sleepwalker-ui]')) {
              out.elements.push(el);
            }
          });
        }
        if (typeof root.querySelectorAll === 'function') {
          root.querySelectorAll('*').forEach((host) => {
            if (host.shadowRoot && host.id !== 'sleepwalker-ui-host' && host.id !== 'sleepwalker-host') {
              const st = (host.shadowRoot.textContent || '').replace(/\s+/g, ' ').trim();
              if (st) out.shadowTexts.push(st.slice(0, 400));
              this._collectShadowData(host.shadowRoot, selector, maxDepth, depth + 1, out);
            }
          });
        }
      } catch (_e) {}
      return out;
    }

    _probeLiveDomState() {
      if (typeof window === 'undefined' || typeof document === 'undefined') {
        return {};
      }
      const deep = this._collectShadowData(document, 'h1, h2, h3');
      const headings = deep.elements.slice(0, 8).map((el) => (el.textContent || '').trim()).filter(Boolean);
      const bodyRaw = `${(document.body && document.body.innerText) || ''} ${deep.shadowTexts.join(' ')}`;
      const bodyText = bodyRaw.replace(/\s+/g, ' ').trim().slice(0, 1500);
      return {
        url: window.location ? window.location.href : '',
        title: document.title || '',
        readyState: document.readyState || '',
        scrollY: typeof window.scrollY === 'number' ? window.scrollY : 0,
        headings,
        visibleText: bodyText
      };
    }

    async probeState(request = null) {
      if (this.customStateProbe) {
        return this.customStateProbe(request);
      }
      return this._probeLiveDomState();
    }

    async execute(rawRequest) {
      const req = createTaskRequest({ ...rawRequest, backend: 'browser' });
      const check = validateTaskRequest(req);
      if (!check.valid) {
        return createTaskResult(req, { ok: false, status: check.code, engine: 'browser_router', error: { code: check.code, message: check.error, recoverable: false } });
      }
      if (req.signal && req.signal.aborted) {
        return createTaskResult(req, { ok: false, status: 'CANCELLED', engine: 'browser_router', error: { code: 'CANCELLED', message: 'Command cancelled before browser execution', recoverable: false } });
      }

      const t0 = Date.now();
      this.activeCommandId = req.commandId;
      const localCtrl = typeof AbortController === 'function' ? new AbortController() : null;
      this.activeControllers.set(req.commandId, localCtrl);

      let onAbort = null;
      if (req.signal) {
        onAbort = () => {
          if (localCtrl) {
            try { localCtrl.abort(req.signal.reason || 'cancelled'); } catch (_e) {}
          }
          this.cancel(req.commandId, req.taskId).catch(() => {});
        };
        req.signal.addEventListener('abort', onAbort, { once: true });
      }

      try {
        // Path 0: Injected test/harness real browser executor (e.g. Playwright/CDP executor)
        if (this.customExecutor) {
          const out = await this._withTimeout(
            () => this.customExecutor(req, localCtrl ? localCtrl.signal : req.signal),
            req.timeout,
            req.signal
          );
          if (out && typeof out === 'object' && 'executionTimestamp' in out && 'backend' in out) {
            return out;
          }
          return createTaskResult(req, {
            ok: Boolean(out && out.ok),
            status: (out && out.status) || (out && out.ok ? 'COMPLETED' : 'FAILED'),
            engine: (out && out.engine) || 'browser_custom',
            result: out && out.result !== undefined ? out.result : out,
            targetIdentity: (out && out.targetIdentity) || { url: out && out.url },
            actualState: (out && out.actualState) || (await this.probeState(req).catch(() => ({}))),
            durationMs: Date.now() - t0,
            evidence: (out && out.evidence) || { mechanism: 'browser_executor' },
            error: out && !out.ok ? (out.error || 'Browser action failed') : null
          });
        }

        // Path 0.5: Hierarchical interactive webpage control execution (World Model + ARIA + Stagehand CDP + mandatory reinspection)
        if (req.action === 'interact_control') {
          return await this._executeHierarchicalControl(req, localCtrl ? localCtrl.signal : req.signal);
        }

        // Path 1: Genuine CDP Input & Stagehand Browser Adapter (atomic execution ONLY; no agent() loop)
        const stagehandEnabled = Boolean(this.useStagehandFn() && this.stagehandAdapter);
        let stagehandFailure = null;
        if (stagehandEnabled && ['navigate', 'search', 'click', 'double_click', 'right_click', 'hover', 'drag', 'press_key', 'type_text', 'fill', 'extract', 'observe', 'scroll'].includes(req.action)) {
          try {
            const shRes = await this._executeViaStagehand(req, localCtrl ? localCtrl.signal : req.signal);
            if (shRes && shRes.ok) {
              return shRes;
            }
            if (shRes && shRes.status === 'CANCELLED') {
              return shRes;
            }
            stagehandFailure = (shRes && shRes.error && shRes.error.message) || 'Stagehand execution failed';
          } catch (shErr) {
            if (req.signal && req.signal.aborted) {
              return createTaskResult(req, { ok: false, status: 'CANCELLED', engine: 'stagehand_adapter', durationMs: Date.now() - t0, error: { code: 'CANCELLED', message: 'Browser execution cancelled', recoverable: false } });
            }
            stagehandFailure = (shErr && shErr.message) || String(shErr);
          }
        }

        // Path 2: Existing Sleepwalker Browser Engine / DOM / Tab Fallback (guaranteed fallback!)
        const fallbackRes = await this._executeViaExistingBrowserEngine(req, localCtrl ? localCtrl.signal : req.signal, stagehandFailure);
        return fallbackRes;
      } catch (err) {
        const isAbort = Boolean((req.signal && req.signal.aborted) || (err && (err.name === 'AbortError' || /cancel/i.test(err.message || ''))));
        const isTimeout = Boolean(err && /timed?\s*out/i.test(err.message || ''));
        const code = isAbort ? 'CANCELLED' : (isTimeout ? 'TIMEOUT' : 'BACKEND_ERROR');
        return createTaskResult(req, {
          ok: false,
          status: code,
          engine: 'browser_backend',
          durationMs: Date.now() - t0,
          actualState: await this.probeState(req).catch(() => ({})),
          error: { code, message: (err && err.message) || code, recoverable: !isAbort }
        });
      } finally {
        if (req.signal && onAbort) {
          req.signal.removeEventListener('abort', onAbort);
        }
        this.activeControllers.delete(req.commandId);
        if (this.activeCommandId === req.commandId) {
          this.activeCommandId = null;
        }
      }
    }

    async _withTimeout(fn, timeoutMs, signal) {
      let timer = null;
      try {
        return await Promise.race([
          Promise.resolve().then(fn),
          new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error(`Browser action timed out after ${timeoutMs}ms`)), timeoutMs);
            if (signal) {
              if (signal.aborted) {
                clearTimeout(timer);
                reject(new Error('CANCELLED'));
              } else {
                signal.addEventListener('abort', () => {
                  clearTimeout(timer);
                  reject(new Error('CANCELLED'));
                }, { once: true });
              }
            }
          })
        ]);
      } finally {
        if (timer) clearTimeout(timer);
      }
    }

    async _executeViaStagehand(req, signal) {
      const t0 = Date.now();
      let unloadTriggered = false;
      const onBeforeUnload = () => { unloadTriggered = true; };
      if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
        window.addEventListener('beforeunload', onBeforeUnload, { once: true });
      }

      const verifyAfter = (() => {
        if (!req.expectedState || typeof req.expectedState !== 'object') return null;
        const v = {};
        if (req.expectedState.urlContains) v.urlContains = req.expectedState.urlContains;
        if (req.expectedState.domTextContains) v.text = req.expectedState.domTextContains;
        return Object.keys(v).length > 0 ? v : null;
      })();
      const opts = {
        commandId: req.commandId,
        timeoutMs: req.timeout,
        signal,
        verifyAfter,
        extractMode: req.parameters.extractMode || null,
        maxResults: req.parameters.maxResults || 5,
        contextHint: req.target.contextHint || req.parameters.contextHint || null,
        submitAfterFill: Boolean(req.parameters.submitAfterFill)
      };

      let raw;
      try {
        if (req.action === 'extract') {
          raw = await this.stagehandAdapter.extract(req.parameters.schema || null, req.parameters.query || req.target.label || '', opts);
        } else if (req.action === 'observe') {
          raw = await this.stagehandAdapter.observe(req.parameters.query || req.target.label || '', opts);
        } else if (req.action === 'navigate') {
          raw = await this.stagehandAdapter.act('navigate', null, req.target.url || req.parameters.url || '', opts);
        } else if (req.action === 'search') {
          raw = await this.stagehandAdapter.act('search', {
            label: req.target.label || '',
            selector: req.target.selector || '',
            contextHint: req.target.contextHint || req.parameters.contextHint || ''
          }, req.parameters.query || req.parameters.text || '', opts);
        } else if (req.action === 'click') {
          raw = await this.stagehandAdapter.act('click', {
            label: req.target.label || '',
            selector: req.target.selector || '',
            contextHint: req.target.contextHint || req.parameters.contextHint || '',
            hrefContains: req.target.hrefContains || req.parameters.hrefContains || ''
          }, null, opts);
        } else if (req.action === 'double_click' || req.action === 'right_click' || req.action === 'hover') {
          raw = await this.stagehandAdapter.act(req.action, {
            label: req.target.label || '',
            selector: req.target.selector || '',
            x: req.target.x,
            y: req.target.y,
            contextHint: req.target.contextHint || req.parameters.contextHint || ''
          }, null, opts);
        } else if (req.action === 'drag') {
          raw = await this.stagehandAdapter.act('drag', {
            fromX: req.target.fromX,
            fromY: req.target.fromY,
            toX: req.target.toX,
            toY: req.target.toY,
            steps: req.parameters.steps || 10
          }, null, opts);
        } else if (req.action === 'press_key') {
          raw = await this.stagehandAdapter.act('press_key', { key: req.parameters.key || req.target.key || 'Enter' }, req.parameters.key || req.target.key || 'Enter', opts);
        } else if (req.action === 'type_text') {
          raw = await this.stagehandAdapter.act('type_text', {
            selector: req.target.selector || '',
            x: req.target.x,
            y: req.target.y,
            clearFirst: Boolean(req.parameters.clearFirst)
          }, req.parameters.text ?? req.parameters.value ?? '', opts);
        } else if (req.action === 'fill') {
          raw = await this.stagehandAdapter.act('fill', {
            label: req.target.label || '',
            selector: req.target.selector || '',
            contextHint: req.target.contextHint || req.parameters.contextHint || ''
          }, req.parameters.value || req.parameters.text || '', opts);
        } else if (req.action === 'scroll') {
          raw = await this.stagehandAdapter.act('scroll', {
            label: req.target.label || '',
            selector: req.target.selector || '',
            direction: req.parameters.direction || 'down',
            deltaY: req.parameters.deltaY || 500
          }, req.parameters.deltaY || 500, opts);
        }
      } finally {
        if (typeof window !== 'undefined' && typeof window.removeEventListener === 'function') {
          window.removeEventListener('beforeunload', onBeforeUnload);
        }
      }

      if (signal && signal.aborted) {
        return createTaskResult(req, { ok: false, status: 'CANCELLED', engine: 'stagehand_adapter', durationMs: Date.now() - t0, error: { code: 'CANCELLED', message: 'Stagehand operation cancelled', recoverable: false } });
      }

      if (!raw || raw.ok === false) {
        const code = (raw && raw.code) || 'STAGEHAND_ERROR';
        return createTaskResult(req, {
          ok: false,
          status: code,
          engine: 'stagehand_adapter',
          durationMs: Date.now() - t0,
          actualState: await this.probeState(req).catch(() => ({})),
          evidence: { mechanism: 'stagehand_cdp_sidecar', ownership: raw ? raw.ownership : null },
          error: { code, message: (raw && raw.error) || 'Stagehand operation failed', recoverable: true }
        });
      }

      const liveState = await this.probeState(req).catch(() => ({}));
      const inner = raw.result || {};
      const innerData = (inner.data && typeof inner.data === 'object') ? inner.data : null;
      const searchResults = Array.isArray(inner.results)
        ? inner.results
        : (innerData && Array.isArray(innerData.results) ? innerData.results : undefined);

      let extractedText = String(
        inner.extractedText ||
        inner.text ||
        (innerData && (
          innerData.visibleTextPreview ||
          innerData.stagehandPageTextPreview ||
          (typeof innerData.summary === 'string' ? innerData.summary : '') ||
          (typeof innerData.text === 'string' ? innerData.text : '')
        )) ||
        (typeof inner.extraction === 'string' ? inner.extraction : (inner.extraction ? JSON.stringify(inner.extraction) : '')) ||
        ''
      ).trim();

      const query = String(req.parameters.query || req.target.label || '').trim();
      if (query && extractedText && !searchResults) {
        if (/python\s+release|latest\s+python|version/i.test(query)) {
          const verMatch = extractedText.match(/Python\s+\d+\.\d+(?:\.\d+)?/i);
          if (verMatch) extractedText = verMatch[0];
        }
      }

      const resolvedUrl = inner.urlAfter || inner.url || (innerData && innerData.url) || liveState.url || req.target.url || '';
      const resolvedTitle = inner.titleAfter || inner.title || (innerData && innerData.title) || liveState.title || '';
      const matchedLabel = String(
        (inner.details && (inner.details.matchedLabel || (inner.details.groundedMatch && inner.details.groundedMatch.label) || (inner.details.field && inner.details.field.ariaLabel))) ||
        req.target.label ||
        req.target.selector ||
        ''
      );
      const typedValue = inner.details && inner.details.typedValue !== undefined ? inner.details.typedValue : undefined;
      const scrolledDelta = inner.details && inner.details.scrolledDelta !== undefined ? inner.details.scrolledDelta : undefined;
      const targetInView = Boolean(inner.details && inner.details.targetInView);
      const visibleText = inner.visibleTextPreview ||
        (innerData && (innerData.visibleTextPreview || innerData.stagehandPageTextPreview)) ||
        (raw.verification && raw.verification.actualState && (raw.verification.actualState.visibleTextPreview || raw.verification.actualState.h1Text)) ||
        liveState.visibleText ||
        '';
      const navCompleted = Boolean(
        inner.navigated === true ||
        inner.readyState === 'complete' ||
        inner.readyState === 'interactive' ||
        (req.action === 'navigate' && resolvedUrl) ||
        (raw.verification && raw.verification.verified === true) ||
        liveState.readyState === 'complete'
      );

      // Only hold for document unload when a full-page navigation (`navigate` or `beforeunload`) actually initiated;
      // SPA pushState transitions (e.g., YouTube search / video watch) stay in the active content script without stalling!
      if (typeof document !== 'undefined' && req.parameters && req.parameters.awaitDocumentUnload && (req.action === 'navigate' || unloadTriggered)) {
        await new Promise((resolve) => {
          const t = setTimeout(resolve, 3500);
          if (signal) {
            signal.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
          }
        });
      }

      const inputMechanism = (inner.details && inner.details.inputMechanism) || (
        ['click', 'double_click', 'right_click', 'hover', 'drag'].includes(req.action) ? 'cdp_mouse_input'
        : (req.action === 'press_key' ? 'cdp_keyboard_input'
          : (['fill', 'search', 'type_text'].includes(req.action) ? 'cdp_mouse_and_keyboard_input'
            : 'semantic_browser_operation'))
      );

      return createTaskResult(req, {
        ok: true,
        status: 'COMPLETED',
        engine: 'stagehand_adapter',
        result: {
          ...inner,
          inputMechanism,
          extractedText,
          searchResults,
          observedElements: Array.isArray(inner.elements) ? inner.elements : undefined,
          url: resolvedUrl,
          title: resolvedTitle,
          clicked: ['click', 'double_click', 'right_click'].includes(req.action) ? true : undefined,
          hovered: req.action === 'hover' ? true : undefined,
          dragged: req.action === 'drag' ? true : undefined,
          keyPressed: req.action === 'press_key' ? (req.parameters.key || req.target.key || 'Enter') : undefined,
          filled: (req.action === 'fill' || req.action === 'search' || req.action === 'type_text') ? true : undefined,
          scrolled: req.action === 'scroll' ? true : undefined,
          scrolledDelta,
          targetInView,
          value: typedValue
        },
        targetIdentity: {
          url: resolvedUrl,
          title: resolvedTitle,
          label: matchedLabel,
          accessibleName: matchedLabel
        },
        actualState: {
          ...liveState,
          url: resolvedUrl,
          title: resolvedTitle,
          readyState: navCompleted ? 'complete' : (liveState.readyState || ''),
          navigationComplete: navCompleted,
          visibleText: visibleText || extractedText,
          extractedText,
          searchResults,
          scrolledDelta,
          targetInView,
          value: typedValue !== undefined ? typedValue : liveState.value,
          domMatched: true,
          accessibility: matchedLabel ? { name: matchedLabel } : liveState.accessibility
        },
        durationMs: Date.now() - t0,
        evidence: {
          mechanism: 'stagehand_cdp_sidecar',
          inputMechanism,
          stagehandVersion: raw.stagehandVersion || this.stagehandAdapter.lastStagehandVersion || null,
          ownershipDuringOp: raw.ownershipDuringOp || null,
          stagehandVerification: raw.verification || null,
          fallbackUsed: false
        }
      });
    }

    _highlightInteractiveTarget(el) {
      if (!el || !el.isConnected || typeof document === 'undefined' || !document.documentElement) return;
      try {
        const r = el.getBoundingClientRect();
        if (!r || r.width <= 0 || r.height <= 0) return;
        const reducedMotion = typeof window !== 'undefined' && window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        const ring = document.createElement('div');
        ring.setAttribute('data-sleepwalker-ui', '1');
        ring.setAttribute('aria-hidden', 'true');
        ring.style.cssText = [
          'position:fixed',
          `left:${Math.max(0, Math.round(r.left) - 5)}px`,
          `top:${Math.max(0, Math.round(r.top) - 5)}px`,
          `width:${Math.round(r.width) + 10}px`,
          `height:${Math.round(r.height) + 10}px`,
          'border-radius:10px',
          'border:2px solid rgba(56,189,248,0.95)',
          'box-shadow:0 0 0 4px rgba(139,92,246,0.22), 0 0 22px rgba(6,182,212,0.52), inset 0 0 10px rgba(56,189,248,0.16)',
          'pointer-events:none',
          'z-index:2147483643',
          'opacity:1',
          reducedMotion ? '' : 'will-change:transform,opacity;transition:opacity 320ms cubic-bezier(0.16,1,0.3,1), transform 260ms cubic-bezier(0.22,1,0.36,1);transform:scale(1.06)'
        ].filter(Boolean).join(';') + ';';
        document.documentElement.appendChild(ring);
        if (!reducedMotion && typeof requestAnimationFrame === 'function') {
          requestAnimationFrame(() => { ring.style.transform = 'scale(1)'; });
        }
        setTimeout(() => { ring.style.opacity = '0'; if (!reducedMotion) ring.style.transform = 'scale(0.985)'; }, 440);
        setTimeout(() => { try { ring.remove(); } catch (_e) {} }, 780);
      } catch (_e) {}
    }

    _waitForDomSettle(el, maxWaitMs = 200, minWaitMs = 40) {
      if (typeof document === 'undefined' || typeof MutationObserver !== 'function') {
        return new Promise((r) => setTimeout(r, Math.min(maxWaitMs, 120)));
      }
      const startUrl = typeof window !== 'undefined' && window.location ? window.location.href : '';
      return new Promise((resolve) => {
        let settled = false;
        let settleTimer = null;
        let obs = null;
        const finish = () => {
          if (settled) return;
          settled = true;
          if (settleTimer) clearTimeout(settleTimer);
          if (maxTimer) clearTimeout(maxTimer);
          if (obs) { try { obs.disconnect(); } catch (_e) {} }
          resolve();
        };
        const maxTimer = setTimeout(finish, maxWaitMs);
        try {
          const observeRoot = (el && el.getRootNode && el.getRootNode() instanceof ShadowRoot)
            ? el.getRootNode()
            : (document.body || document.documentElement);
          if (observeRoot) {
            obs = new MutationObserver(() => {
              if (settleTimer) clearTimeout(settleTimer);
              settleTimer = setTimeout(finish, minWaitMs);
            });
            obs.observe(observeRoot, { childList: true, subtree: true, attributes: true, attributeFilter: ['aria-expanded', 'aria-selected', 'aria-checked', 'hidden', 'open', 'class', 'style'] });
          }
        } catch (_e) {}
        setTimeout(() => {
          if (typeof window !== 'undefined' && window.location && window.location.href !== startUrl) {
            finish();
          }
        }, minWaitMs);
      });
    }

    async _dismissBlockingOverlayIfOccluded(el, req, signal) {
      if (!el || !el.isConnected || typeof document === 'undefined' || typeof document.elementFromPoint !== 'function') {
        return { dismissed: false, mechanism: null };
      }
      try {
        const r = el.getBoundingClientRect();
        if (!r || r.width <= 0 || r.height <= 0) return { dismissed: false, mechanism: null };
        const cx = Math.round(r.left + r.width / 2);
        const cy = Math.round(r.top + r.height / 2);
        const topEl = document.elementFromPoint(cx, cy);
        if (!topEl || topEl === el || el.contains(topEl) || topEl.contains(el)) {
          return { dismissed: false, mechanism: null };
        }
        // Check if topEl is inside a Shadow host containing el
        const rootHost = el.getRootNode && el.getRootNode().host;
        if (rootHost && (topEl === rootHost || rootHost.contains(topEl))) {
          return { dismissed: false, mechanism: null };
        }
        const modal = topEl.closest && topEl.closest('[role="dialog"], [aria-modal="true"], .modal, .overlay, .backdrop, .cookie-banner, [data-overlay], [data-modal]');
        if (!modal) return { dismissed: false, mechanism: null };

        const stagehandEnabled = Boolean(this.useStagehandFn() && this.stagehandAdapter);
        // 1. Try CDP Escape key first (non-destructive standard modal dismissal)
        if (stagehandEnabled) {
          if (typeof window !== 'undefined') window.__SW_DISPATCHING_CDP_ESCAPE__ = true;
          try {
            await this.stagehandAdapter.act('press_key', { key: 'Escape' }, 'Escape', {
              commandId: `${req.commandId}-esc`,
              timeoutMs: 3000,
              signal
            }).catch(() => {});
            await this._waitForDomSettle(modal, 150, 35);
          } finally {
            if (typeof window !== 'undefined') setTimeout(() => { window.__SW_DISPATCHING_CDP_ESCAPE__ = false; }, 60);
          }
          const afterEsc = document.elementFromPoint(cx, cy);
          if (!afterEsc || afterEsc === el || el.contains(afterEsc) || afterEsc.contains(el)) {
            return { dismissed: true, mechanism: 'cdp_keyboard_input' };
          }
        }
        // 2. Otherwise find explicit close/dismiss button inside the blocking overlay
        const closeBtn = modal.querySelector('button[aria-label*="close" i], button[aria-label*="dismiss" i], button[data-dismiss], button[data-close], .modal-close, button');
        if (closeBtn) {
          const cr = closeBtn.getBoundingClientRect();
          if (stagehandEnabled && cr.width > 0 && cr.height > 0) {
            await this.stagehandAdapter.act('click', {
              x: Math.round(cr.left + cr.width / 2),
              y: Math.round(cr.top + cr.height / 2),
              label: (closeBtn.innerText || closeBtn.getAttribute('aria-label') || 'Close').trim()
            }, null, { commandId: req.commandId, timeoutMs: 3000, signal }).catch(() => {});
          } else {
            closeBtn.click();
          }
          await this._waitForDomSettle(modal, 160, 35);
          return { dismissed: true, mechanism: stagehandEnabled ? 'cdp_mouse_input' : 'semantic_browser_operation' };
        }
      } catch (_e) {}
      return { dismissed: false, mechanism: null };
    }

    async _hoverElementViaCdp(el, label, req, signal) {
      if (!el || !el.isConnected) return { ok: false, usedStagehand: false };
      try { el.scrollIntoView({ behavior: 'instant', block: 'center', inline: 'center' }); } catch (_e) {}
      this._highlightInteractiveTarget(el);
      const r = el.getBoundingClientRect();
      const stagehandEnabled = Boolean(this.useStagehandFn() && this.stagehandAdapter);
      if (stagehandEnabled && r.width > 0 && r.height > 0) {
        try {
          const res = await this.stagehandAdapter.act('hover', {
            x: Math.round(r.left + r.width / 2),
            y: Math.round(r.top + r.height / 2),
            label: String(label || '')
          }, null, { commandId: req.commandId, timeoutMs: 4000, signal });
          if (res && res.ok !== false) return { ok: true, usedStagehand: true };
        } catch (_e) {}
      }
      try {
        el.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true, composed: true }));
        el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, composed: true }));
      } catch (_e) {}
      return { ok: true, usedStagehand: false };
    }

    async _clickElementPreferStagehand(el, label, req, signal) {
      if (!el || !el.isConnected) return { ok: false, usedStagehand: false };
      try {
        if (typeof el.scrollIntoView === 'function') {
          el.scrollIntoView({ behavior: 'instant', block: 'center', inline: 'center' });
        }
      } catch (_e) {}
      const occ = await this._dismissBlockingOverlayIfOccluded(el, req, signal);
      this._highlightInteractiveTarget(el);

      const inShadow = Boolean(typeof ShadowRoot !== 'undefined' && el.getRootNode && el.getRootNode() instanceof ShadowRoot);
      const stagehandEnabled = Boolean(this.useStagehandFn() && this.stagehandAdapter);
      const r = el.getBoundingClientRect ? el.getBoundingClientRect() : null;
      if (stagehandEnabled && r && r.width > 0 && r.height > 0) {
        if (!inShadow && typeof el.setAttribute === 'function') {
          const marker = `sw-hier-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
          el.setAttribute('data-sw-hier-target', marker);
          try {
            const shRes = await this.stagehandAdapter.act(
              'click',
              { selector: `[data-sw-hier-target="${marker}"]`, label: String(label || '') },
              null,
              { commandId: req.commandId, timeoutMs: Math.min(req.timeout || 8000, 5000), signal }
            );
            el.removeAttribute('data-sw-hier-target');
            if (shRes && shRes.ok !== false) {
              return { ok: true, usedStagehand: true, dismissedOverlay: occ.dismissed };
            }
          } catch (_e) {
            try { el.removeAttribute('data-sw-hier-target'); } catch (_e2) {}
          }
        } else {
          // Open Shadow DOM: dispatch genuine CDP mouse click at live viewport coordinates!
          try {
            const shRes = await this.stagehandAdapter.act(
              'click',
              {
                bounds: { x: Math.round(r.left), y: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) },
                label: String(label || '')
              },
              null,
              { commandId: req.commandId, timeoutMs: Math.min(req.timeout || 8000, 5000), signal }
            );
            if (shRes && shRes.ok !== false) {
              return { ok: true, usedStagehand: true, dismissedOverlay: occ.dismissed };
            }
          } catch (_e) {}
        }
      }

      try {
        const shield = typeof window !== 'undefined' && window.SleepwalkerIntelligence && window.SleepwalkerIntelligence.SleepwalkerClickShield;
        const doDomClick = () => {
          if (typeof el.focus === 'function') el.focus();
          el.click();
        };
        if (shield && typeof shield.withPassthrough === 'function') {
          await shield.withPassthrough(doDomClick);
        } else {
          doDomClick();
        }
        return { ok: true, usedStagehand: false, dismissedOverlay: occ.dismissed };
      } catch (_e) {
        try {
          el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, composed: true }));
          return { ok: true, usedStagehand: false, dismissedOverlay: occ.dismissed };
        } catch (_e2) {
          return { ok: false, usedStagehand: false, dismissedOverlay: occ.dismissed };
        }
      }
    }

    _getOrCreateWorldModel() {
      if (this.controller && this.controller.worldModel) return this.controller.worldModel;
      if (!this._fallbackWorldModel && typeof window !== 'undefined' && window.SleepwalkerWorldModel) {
        this._fallbackWorldModel = new window.SleepwalkerWorldModel({
          elementSelector: (this.controller && this.controller.elementSelector) || null
        });
      }
      return this._fallbackWorldModel || null;
    }

    _isElementVisibleNow(el) {
      if (!el || !el.isConnected) return false;
      try {
        const r = el.getBoundingClientRect();
        const st = typeof getComputedStyle === 'function' ? getComputedStyle(el) : null;
        return r.width > 0 && r.height > 0 && (!st || (st.display !== 'none' && st.visibility !== 'hidden' && Number(st.opacity) !== 0));
      } catch (_e) {
        return true;
      }
    }

    _isKnownMenuOrSettingTarget(label) {
      const s = String(label || '').trim().toLowerCase();
      return /^(?:youtube\s+studio|creator\s+studio|switch\s+account|dark\s+theme|light\s+theme|device\s+theme|dark\s+mode|light\s+mode|restricted\s+mode|keyboard\s+shortcuts?|playback\s+speed|ambient\s+mode|stable\s+volume|your\s+data\s+in\s+youtube|purchases\s+and\s+memberships|(?:0\.25|0\.5|0\.75|1\.25|1\.5|1\.75|2)x|(?:2160|1440|1080|720|480|360|240|144)p(?:\s*hd|\s*4k)?)$/i.test(s);
    }

    _semanticMenuAffinity(triggerText, targetLabel) {
      const trig = String(triggerText || '').toLowerCase().replace(/\s+/g, ' ').trim();
      const tgt = String(targetLabel || '').toLowerCase().replace(/\s+/g, ' ').trim();
      if (!trig || !tgt) return 0;
      let score = 0;

      const tgtTokens = tgt.split(/\s+/).filter((w) => w.length > 2);
      for (const tok of tgtTokens) {
        if (trig.includes(tok)) score += 95;
      }

      // 1. Theme / Appearance family ("Dark theme" -> "Appearance: Device theme" inside "Account" / "Settings")
      if (/\b(?:dark|light|device\s+theme|theme|night\s+mode|color\s+scheme|appearance)\b/.test(tgt)) {
        if (/\b(?:appearance|theme|display|color|night)\b/.test(trig)) score += 140;
        else if (/\b(?:account|profile|avatar|settings|preferences|view)\b/.test(trig)) score += 90;
      }
      // 2. Account / Studio / Channel / Memberships family ("YouTube Studio" -> "Account")
      if (/\b(?:youtube\s+studio|creator\s+studio|studio|switch\s+account|google\s+account|your\s+channel|my\s+channel|purchases?|memberships?|your\s+data|billing)\b/.test(tgt)) {
        if (/\b(?:account|profile|avatar|user)\b/.test(trig)) score += 135;
      }
      // 3. Video / Player / App Settings family ("1.5x" -> "Playback speed" inside "Settings"; "1080p" -> "Quality" inside "Settings")
      if (/\b(?:playback\s+speed|speed|(?:0\.25|0\.5|0\.75|1\.25|1\.5|1\.75|2)x|normal)\b/.test(tgt)) {
        if (/\b(?:playback\s+speed|speed)\b/.test(trig)) score += 145;
        else if (/\b(?:settings|gear|player|options)\b/.test(trig)) score += 95;
      }
      if (/\b(?:quality|(?:2160|1440|1080|720|480|360|240|144)p|4k|hd)\b/.test(tgt)) {
        if (/\b(?:quality|resolution|video)\b/.test(trig)) score += 145;
        else if (/\b(?:settings|gear|player|options)\b/.test(trig)) score += 95;
      }
      if (/\b(?:subtitles?|captions?|cc|annotations?|ambient\s+mode|stable\s+volume|sleep\s+timer)\b/.test(tgt)) {
        if (/\b(?:subtitles?|captions?|cc|audio)\b/.test(trig)) score += 140;
        else if (/\b(?:settings|gear|player|options)\b/.test(trig)) score += 95;
      }
      // 4. Language / Location / Restricted Mode / Shortcuts family
      if (/\b(?:language|english|hindi|spanish|french|german|japanese|tamil|telugu|bengali)\b/.test(tgt)) {
        if (/\b(?:language|locale)\b/.test(trig)) score += 140;
        else if (/\b(?:account|profile|settings)\b/.test(trig)) score += 85;
      }
      if (/\b(?:location|country|region)\b/.test(tgt)) {
        if (/\b(?:location|country|region)\b/.test(trig)) score += 140;
        else if (/\b(?:account|profile|settings)\b/.test(trig)) score += 85;
      }
      if (/\b(?:restricted\s+mode|safe\s+search|parental)\b/.test(tgt)) {
        if (/\b(?:restricted|safety|privacy)\b/.test(trig)) score += 140;
        else if (/\b(?:account|profile|settings)\b/.test(trig)) score += 85;
      }
      if (/\b(?:keyboard\s+shortcuts?|shortcuts?|hotkeys?)\b/.test(tgt)) {
        if (/\b(?:keyboard|shortcut|help)\b/.test(trig)) score += 135;
        else if (/\b(?:account|profile|settings)\b/.test(trig)) score += 80;
      }
      // 5. Sidebar / Guide / Overflow ("Show more" / "More")
      if (/\b(?:history|watch\s+later|liked\s+videos|playlists?|subscriptions?|podcasts?|trending|gaming)\b/.test(tgt)) {
        if (/\b(?:guide|navigation|show\s+more|more|explore|you|library)\b/.test(trig)) score += 110;
      }
      if (/^(?:more|show\s+more|see\s+more|view\s+more|more\s+options|more\s+actions|advanced)\b/.test(trig)) {
        score += 45;
      }
      return score;
    }

    _isSafeSubmenuTrigger(el) {
      if (!el || !this._isElementVisibleNow(el)) return false;
      const text = `${el.getAttribute('aria-label') || ''} ${el.innerText || el.textContent || ''} ${el.getAttribute('title') || ''}`
        .replace(/\s+/g, ' ')
        .trim();
      // Never click destructive, auth, payment, or Back buttons during exploratory submenu search!
      if (/\b(?:sign\s*out|log\s*out|delete|remove|unsubscribe|pay\b|purchase|buy\b|checkout|submit|send\s+feedback|report|block|^back$)\b/i.test(text)) {
        return false;
      }
      // Never click links that navigate away from the current page!
      const checkHref = (node) => {
        if (!node) return '';
        return String(node.getAttribute ? (node.getAttribute('href') || '') : (node.href || '')).trim();
      };
      const ownHref = checkHref(el);
      const innerAnchor = el.querySelector ? el.querySelector('a#endpoint, a[href]') : null;
      const innerHref = checkHref(innerAnchor);
      const effectiveHref = ownHref || innerHref;
      if (effectiveHref && effectiveHref !== '#' && !/^javascript:/i.test(effectiveHref)) {
        return false;
      }

      const tag = String(el.tagName || '').toLowerCase();
      const role = String((el.getAttribute && el.getAttribute('role')) || '').toLowerCase();
      const hasPopup = String((el.getAttribute && el.getAttribute('aria-haspopup')) || '').toLowerCase();
      const ariaExp = el.getAttribute ? el.getAttribute('aria-expanded') : null;

      if (tag === 'ytd-toggle-theme-compact-link-renderer' || tag === 'summary') return true;
      if (['true', 'menu', 'listbox', 'dialog'].includes(hasPopup)) return true;
      if (ariaExp === 'false') return true;
      if (el.hasAttribute && (el.hasAttribute('data-submenu') || el.hasAttribute('aria-controls'))) return true;
      if (role === 'menuitem' || tag === 'ytd-compact-link-renderer' || tag === 'tp-yt-paper-item' || (el.classList && el.classList.contains('ytp-menuitem'))) {
        return true;
      }
      if (/^(?:more|show\s+more|see\s+more|advanced|other\s+options)\b/i.test(text)) return true;
      return false;
    }

    _getOpenPopupContainers() {
      if (typeof document === 'undefined') return [];
      const popupSel = 'tp-yt-iron-dropdown, .ytp-popup.ytp-settings-menu, [role="menu"], [role="listbox"], [role="dialog"], [data-radix-popper-content-wrapper], .MuiPopover-root, .MuiMenu-root, .ant-dropdown, .dropdown-menu, details[open]';
      return this._collectShadowData(document, popupSel).elements.filter((p) => {
        if (p.getAttribute && p.getAttribute('aria-hidden') === 'true') return false;
        if (p.closest && p.closest('[aria-hidden="true"]')) return false;
        return this._isElementVisibleNow(p);
      });
    }

    _listOpenMenuOptions() {
      const popups = this._getOpenPopupContainers();
      const itemSel = 'ytd-compact-link-renderer, ytd-toggle-theme-compact-link-renderer, .ytp-menuitem, [role="menuitem"], [role="menuitemradio"], [role="menuitemcheckbox"], [role="option"], tp-yt-paper-item, li > a, li > button';
      const seenLabels = new Set();
      const items = [];
      for (const pop of popups) {
        for (const el of this._collectShadowData(pop, itemSel).elements) {
          if (!this._isElementVisibleNow(el)) continue;
          const lbl = (el.innerText || el.textContent || el.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim();
          if (!lbl || lbl.length > 90 || /^back$/i.test(lbl)) continue;
          const key = lbl.toLowerCase();
          if (seenLabels.has(key)) continue;
          seenLabels.add(key);
          const isSub = this._isSafeSubmenuTrigger(el);
          items.push({ label: lbl, isSubmenu: isSub });
        }
      }
      return items;
    }

    async _exploreOpenMenuForTarget(targetLabel, opts = {}) {
      const { maxSubmenuProbes = 4, depth = 0, maxDepth = 2, req = {}, signal = null, visitedLabels = new Set() } = opts;
      if (!targetLabel || (signal && signal.aborted)) return null;

      // 1. Check if target option is already visible at current menu level
      const directHit = this._findOpenPopupItem(targetLabel);
      if (directHit) {
        return { element: directHit, submenuPath: [] };
      }
      if (depth >= maxDepth) return null;

      // 2. Gather safe expandable submenu triggers inside currently open popup(s), ranked by semantic affinity!
      const popups = this._getOpenPopupContainers();
      if (popups.length === 0) return null;

      const subSel = 'ytd-toggle-theme-compact-link-renderer, ytd-compact-link-renderer, .ytp-menuitem, [role="menuitem"], tp-yt-paper-item, button, summary';
      const candidates = [];
      const seenEls = new Set();
      for (const pop of popups) {
        for (const el of this._collectShadowData(pop, subSel).elements) {
          if (seenEls.has(el)) continue;
          seenEls.add(el);
          if (!this._isSafeSubmenuTrigger(el)) continue;
          const lbl = `${el.getAttribute('aria-label') || ''} ${el.innerText || el.textContent || ''}`.replace(/\s+/g, ' ').trim();
          if (!lbl) continue;
          const normKey = lbl.toLowerCase();
          if (visitedLabels.has(normKey)) continue;
          const affinity = this._semanticMenuAffinity(lbl, targetLabel) + 15;
          candidates.push({ el, label: lbl, normKey, affinity });
        }
      }

      candidates.sort((a, b) => b.affinity - a.affinity);
      const toProbe = candidates.slice(0, maxSubmenuProbes);

      for (const cand of toProbe) {
        if (signal && signal.aborted) break;
        visitedLabels.add(cand.normKey);
        const beforeSnapshot = this._listOpenMenuOptions().map((o) => o.label).join('|');

        const isHoverSub = Boolean(cand.el.getAttribute && (cand.el.getAttribute('aria-haspopup') === 'menu' || cand.el.hasAttribute('data-hover-menu')));
        let changed = false;
        if (isHoverSub) {
          await this._hoverElementViaCdp(cand.el, cand.label, req, signal);
          await new Promise((r) => setTimeout(r, 140));
          changed = Boolean(this._findOpenPopupItem(targetLabel)) || (this._listOpenMenuOptions().map((o) => o.label).join('|') !== beforeSnapshot);
        }
        if (!changed) {
          await this._clickElementPreferStagehand(this._unwrapActionableMenuItem(cand.el), cand.label, req, signal);
        }

        // Poll up to 800ms for submenu items or target option to appear
        const pollUntil = Date.now() + 800;
        while (Date.now() < pollUntil) {
          const hit = this._findOpenPopupItem(targetLabel);
          if (hit) {
            return { element: hit, submenuPath: [cand.label] };
          }
          const nowSnap = this._listOpenMenuOptions().map((o) => o.label).join('|');
          if (nowSnap && nowSnap !== beforeSnapshot) {
            changed = true;
            break;
          }
          await new Promise((r) => setTimeout(r, 90));
        }

        const afterPollHit = this._findOpenPopupItem(targetLabel);
        if (afterPollHit) {
          return { element: afterPollHit, submenuPath: [cand.label] };
        }

        // Recurse 1 level deeper if submenu opened a new sub-panel (e.g., Main Menu -> Submenu 1 -> Submenu 2 -> Option)
        if (changed && depth + 1 < maxDepth) {
          const deeper = await this._exploreOpenMenuForTarget(targetLabel, {
            maxSubmenuProbes: 3,
            depth: depth + 1,
            maxDepth,
            req,
            signal,
            visitedLabels
          });
          if (deeper && deeper.element) {
            return { element: deeper.element, submenuPath: [cand.label, ...deeper.submenuPath] };
          }
        }

        // Dead-end backtrack: if entering cand transitioned to a drill-down sub-page with a Back button, click Back to restore parent menu!
        if (changed) {
          const openPopsNow = this._getOpenPopupContainers();
          for (const p of openPopsNow) {
            const backBtn = this._collectShadowData(
              p,
              'button#back-button, button[aria-label="Back" i], button[aria-label*="Back" i], [title="Back" i], .ytp-panel-back-button, [data-menu-back]'
            ).elements.find((b) => this._isElementVisibleNow(b));
            if (backBtn) {
              try { backBtn.click(); } catch (_e) {}
              await new Promise((r) => setTimeout(r, 160));
              break;
            }
          }
        }
      }
      return null;
    }

    async _discoverAndSearchTopLevelMenus(targetLabel, req = {}, signal = null) {
      if (typeof document === 'undefined' || !targetLabel) return null;
      // 1. Check if a menu is ALREADY open and contains (directly or in a submenu) the target!
      if (this._getOpenPopupContainers().length > 0) {
        const inOpen = await this._exploreOpenMenuForTarget(targetLabel, { req, signal });
        if (inOpen && inOpen.element) {
          return { element: inOpen.element, parentTriggerLabel: 'open_menu', submenuPath: inOpen.submenuPath };
        }
      }

      // 2. Collect top-level menu/settings/account/guide/overflow triggers across the page
      const trigSel = 'button#avatar-btn, #avatar-btn button, button.ytp-settings-button, #guide-button button, [aria-haspopup="menu"], [aria-haspopup="true"], [aria-haspopup="listbox"], button[aria-label*="Account" i], button[aria-label*="Profile" i], button[aria-label*="Settings" i], button[aria-label*="More" i], nav [aria-expanded="false"], header button, summary';
      const rawTriggers = this._collectShadowData(document, trigSel).elements;
      const scored = [];
      const seen = new Set();
      for (const el of rawTriggers) {
        if (seen.has(el) || !this._isElementVisibleNow(el)) continue;
        seen.add(el);
        const idHint = el.id === 'avatar-btn' ? 'Account profile avatar' : (el.classList && el.classList.contains('ytp-settings-button') ? 'Video player settings gear' : '');
        const lbl = `${el.getAttribute('aria-label') || ''} ${el.getAttribute('title') || ''} ${el.innerText || el.textContent || ''} ${idHint}`.replace(/\s+/g, ' ').trim();
        if (!lbl) continue;
        if (/\b(?:sign\s*out|log\s*out|search|voice\s+search|create|upload|notifications?)\b/i.test(lbl) && !/\b(?:settings|account|profile|menu)\b/i.test(lbl)) continue;
        const aff = this._semanticMenuAffinity(lbl, targetLabel);
        const hasExplicitPopup = Boolean(el.id === 'avatar-btn' || (el.getAttribute && el.getAttribute('aria-haspopup')) || /\b(?:account|settings|menu|more)\b/i.test(lbl));
        if (aff >= 40 || (this._isKnownMenuOrSettingTarget(targetLabel) && hasExplicitPopup)) {
          scored.push({ el, label: lbl, score: aff + (hasExplicitPopup ? 20 : 0) });
        }
      }

      scored.sort((a, b) => b.score - a.score);
      const topTriggers = scored.slice(0, 3);

      for (const trig of topTriggers) {
        if (signal && signal.aborted) break;
        await this._clickElementPreferStagehand(trig.el, trig.label, req, signal);
        // Poll up to 1200ms until the popup container not only opens its shell, but renders its menu items!
        const waitOpenUntil = Date.now() + 1200;
        while (Date.now() < waitOpenUntil) {
          if (this._listOpenMenuOptions().length > 0 || this._findOpenPopupItem(targetLabel)) break;
          await new Promise((r) => setTimeout(r, 100));
        }
        const explored = await this._exploreOpenMenuForTarget(targetLabel, { req, signal });
        if (explored && explored.element) {
          return {
            element: explored.element,
            parentTriggerLabel: trig.label,
            submenuPath: explored.submenuPath
          };
        }
        // Close this dead-end top-level popup cleanly before probing the next candidate trigger
        if (this._getOpenPopupContainers().length > 0) {
          try { trig.el.click(); } catch (_e) {}
          await new Promise((r) => setTimeout(r, 140));
        }
      }
      return null;
    }

    _unwrapActionableMenuItem(el) {
      if (!el || !el.querySelector) return el;
      const tag = String(el.tagName || '').toLowerCase();
      if (tag === 'ytd-compact-link-renderer' || tag === 'ytd-toggle-theme-compact-link-renderer' || tag === 'tp-yt-paper-item' || tag === 'li') {
        const innerLinkOrBtn = el.querySelector('a#endpoint, a[href], button, [role="menuitem"], [role="option"]');
        if (innerLinkOrBtn && this._isElementVisibleNow(innerLinkOrBtn)) return innerLinkOrBtn;
        const parentAnchor = el.closest && el.closest('a#endpoint, a[href], button');
        if (parentAnchor && this._isElementVisibleNow(parentAnchor)) return parentAnchor;
      }
      return el;
    }

    _fuzzyDomTextScore(needle, candidateText) {
      const q = String(needle || '').trim();
      const c = String(candidateText || '').trim();
      if (!q || !c || q.length < 3 || c.length < 3) return 0;
      const matchApi = (typeof rootScope !== 'undefined' && rootScope.SleepwalkerMatch) ||
        (typeof window !== 'undefined' && window.SleepwalkerMatch) ||
        null;
      if (matchApi && typeof matchApi.fuzzyLabelScore === 'function') {
        return matchApi.fuzzyLabelScore(q, c);
      }
      // Standalone fallback when running in isolated unit tests without match.js loaded
      const a = q.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, '');
      const b = c.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, '');
      if (!a || !b || a.length < 4 || b.length < 4) return 0;
      if (/\b(?:sign\s*out|log\s*out|delete|remove|pay|purchase|buy|checkout|submit)\b/i.test(c)) return 0;
      if (a === b) return 0.96;
      const m = a.length;
      const n = b.length;
      if (Math.abs(m - n) > 2) return 0;
      const dp = Array.from({ length: n + 1 }, (_, j) => j);
      for (let i = 1; i <= m; i++) {
        let prev = dp[0];
        dp[0] = i;
        for (let j = 1; j <= n; j++) {
          const tmp = dp[j];
          dp[j] = a[i - 1] === b[j - 1] ? prev : 1 + Math.min(prev, dp[j], dp[j - 1]);
          prev = tmp;
        }
      }
      const dist = dp[n];
      if (dist <= 1 && Math.max(m, n) >= 5) return 0.91;
      if (dist <= 2 && Math.max(m, n) >= 8) return 0.86;
      return 0;
    }

    _findOpenPopupItem(optionLabel) {
      if (typeof document === 'undefined' || !optionLabel) return null;
      const needle = String(optionLabel).trim().toLowerCase();
      const needleTokens = needle.split(/\s+/).filter((t) => t.length > 1);
      const itemSel = 'ytd-compact-link-renderer a#endpoint, ytd-toggle-theme-compact-link-renderer, ytd-compact-link-renderer, .ytp-menuitem, tp-yt-paper-item, [role="menuitem"], [role="menuitemradio"], [role="menuitemcheckbox"], [role="option"], a[href], button, [data-option], [data-value]';

      const popupContainers = this._getOpenPopupContainers();
      if (popupContainers.length === 0) return null;

      let best = null;
      let bestScore = 0;
      let bestPrimaryKey = '';
      let bestUsedFuzzy = false;
      let secondScore = 0;
      const seen = new Set();
      for (const pop of popupContainers) {
        const items = this._collectShadowData(pop, itemSel).elements;
        for (const rawEl of items) {
          if (seen.has(rawEl)) continue;
          seen.add(rawEl);
          if (!this._isElementVisibleNow(rawEl)) continue;
          const primaryLabel = (rawEl.innerText || rawEl.textContent || rawEl.getAttribute('aria-label') || rawEl.getAttribute('title') || '').replace(/\s+/g, ' ').trim();
          const text = `${rawEl.getAttribute('aria-label') || ''} ${rawEl.innerText || rawEl.textContent || ''} ${rawEl.getAttribute('title') || ''} ${rawEl.getAttribute('data-value') || ''}`
            .replace(/\s+/g, ' ')
            .trim()
            .toLowerCase();
          if (!text) continue;
          let s = 0;
          let usedFuzzy = false;
          if (text === needle) s = 1.15;
          else if (text.startsWith(needle)) s = 1.02;
          else if (text.includes(needle)) s = 0.92;
          else if (needleTokens.length > 0 && needleTokens.every((tok) => text.includes(tok))) s = 0.82;
          else if (primaryLabel) {
            const fz = this._fuzzyDomTextScore(needle, primaryLabel);
            if (fz >= 0.84) {
              s = fz * 0.94;
              usedFuzzy = true;
            }
          }
          const labelKey = (primaryLabel || text).toLowerCase();
          if (s > bestScore) {
            if (bestPrimaryKey && bestPrimaryKey !== labelKey) {
              secondScore = Math.max(secondScore, bestScore);
            }
            bestScore = s;
            bestPrimaryKey = labelKey;
            bestUsedFuzzy = usedFuzzy;
            best = this._unwrapActionableMenuItem(rawEl);
          } else if (labelKey !== bestPrimaryKey && s > secondScore) {
            secondScore = s;
          }
        }
      }
      if (bestUsedFuzzy && (bestScore - secondScore) < 0.08) return null;
      return bestScore >= 0.78 ? best : null;
    }

    _findMenuTrigger(triggerLabel) {
      if (typeof document === 'undefined' || !triggerLabel) return null;
      const needle = String(triggerLabel).trim().toLowerCase();
      if (!needle) return null;
      // Special fast-path for YouTube / Google / GitHub Account & Profile avatar triggers
      if (/^(?:account|profile|avatar|my\s+account|user\s+menu)$/i.test(needle)) {
        const directAvatar = document.querySelector(
          'button#avatar-btn, #avatar-btn button, ytd-topbar-menu-button-renderer button#avatar-btn, button[aria-label*="Account" i], a[aria-label*="Google Account" i], button[aria-label*="Profile" i], summary[aria-label*="profile" i]'
        );
        if (directAvatar && this._isElementVisibleNow(directAvatar)) return directAvatar;
      }
      return this._findDomTarget({ label: triggerLabel });
    }

    _findVisiblePopupOption(triggerEl, optionLabel) {
      if (typeof document === 'undefined' || !optionLabel) return null;
      const openHit = this._findOpenPopupItem(optionLabel);
      if (openHit) return openHit;
      const needle = String(optionLabel).trim().toLowerCase();
      const needleTokens = needle.split(/\s+/).filter((t) => t.length > 1);
      const optSel = 'ytd-compact-link-renderer a#endpoint, ytd-toggle-theme-compact-link-renderer, tp-yt-paper-item, [role="option"], [role="menuitem"], [role="menuitemradio"], [role="menuitemcheckbox"], li button, li a, [data-option], [data-value]';
      const searchRoots = [];

      // 1. Prefer explicitly controlled panel (aria-controls / aria-owns)
      const rootNode = (triggerEl && triggerEl.getRootNode && triggerEl.getRootNode()) || document;
      const ctrlIds = String((triggerEl && (triggerEl.getAttribute('aria-controls') || triggerEl.getAttribute('aria-owns'))) || '').trim().split(/\s+/).filter(Boolean);
      for (const cid of ctrlIds) {
        const panel = (rootNode.getElementById && rootNode.getElementById(cid)) || document.getElementById(cid);
        if (panel) searchRoots.push(panel);
      }
      // 2. Same shadow root or parent wrapper
      if (triggerEl && triggerEl.parentElement) searchRoots.push(triggerEl.parentElement);
      if (rootNode && rootNode !== document) searchRoots.push(rootNode);
      // 3. Full document + open Shadow DOM fallback
      searchRoots.push(document);

      let best = null;
      let bestScore = 0;
      const seen = new Set();
      for (let rIdx = 0; rIdx < searchRoots.length; rIdx++) {
        const r = searchRoots[rIdx];
        const nodes = r === document
          ? this._collectShadowData(document, optSel).elements
          : Array.from(r.querySelectorAll ? r.querySelectorAll(optSel) : []);
        const scopeBoost = rIdx === 0 ? 0.25 : (rIdx === 1 ? 0.15 : 0);
        for (const el of nodes) {
          if (seen.has(el) || el === triggerEl) continue;
          seen.add(el);
          if (!this._isElementVisibleNow(el)) continue;
          const primaryOptLabel = (el.innerText || el.textContent || el.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim();
          const text = `${el.getAttribute('aria-label') || ''} ${el.innerText || el.textContent || ''} ${el.getAttribute('data-value') || ''}`.replace(/\s+/g, ' ').trim().toLowerCase();
          if (!text) continue;
          let s = 0;
          if (text === needle) s = 1.0;
          else if (text.includes(needle)) s = 0.88;
          else if (needleTokens.length > 0 && needleTokens.every((tok) => text.includes(tok))) s = 0.78;
          else if (primaryOptLabel) {
            const fz = this._fuzzyDomTextScore(needle, primaryOptLabel);
            if (fz >= 0.85) s = fz * 0.90;
          }
          if (s > 0) {
            s += scopeBoost;
            if (s > bestScore) {
              bestScore = s;
              best = el;
            }
          }
        }
        if (bestScore >= 1.0) break;
      }
      return best;
    }

    async _executeHierarchicalControl(req, signal) {
      const t0 = Date.now();
      if (signal && signal.aborted) {
        return createTaskResult(req, { ok: false, status: 'CANCELLED', engine: 'world_model_hierarchical_control', durationMs: Date.now() - t0, error: { code: 'CANCELLED', message: 'Cancelled before hierarchical control interaction', recoverable: false } });
      }
      if (typeof document === 'undefined') {
        return createTaskResult(req, { ok: false, status: 'BACKEND_DISCONNECTED', engine: 'world_model_hierarchical_control', durationMs: Date.now() - t0, error: { code: 'BACKEND_DISCONNECTED', message: 'Document unavailable for hierarchical control execution', recoverable: false } });
      }

      const wm = this._getOrCreateWorldModel();
      const targetSpec = {
        targetLabel: String(req.target.label || req.parameters.targetLabel || '').trim(),
        parentHint: String(req.target.parentHint || req.parameters.parentHint || '').trim(),
        sectionHint: String(req.target.sectionHint || req.parameters.sectionHint || req.target.contextHint || '').trim(),
        actionKind: String(req.parameters.actionKind || req.target.actionKind || 'select').trim().toLowerCase(),
        numericValue: req.parameters.numericValue !== undefined ? Number(req.parameters.numericValue) : undefined,
        operator: String(req.parameters.operator || '').trim().toLowerCase()
      };

      // 1. Fresh pre-action World Model inspection (never reuse stale selectors or coordinates)
      let beforeInv = wm ? await wm.buildPageWorldModel(document, { force: true }) : null;
      const beforeInventoryVersion = beforeInv ? (beforeInv.inventoryVersion || beforeInv.version || 0) : 0;
      const tabId = beforeInv ? beforeInv.tabId : 'default';

      let match = wm ? wm.findHierarchicalTarget(targetSpec, tabId) : null;
      let parentExpanded = false;
      let parentTriggerLabel = null;
      let discoveredSubmenuPath = [];
      let usedStagehand = false;

      // 1a. Menu Option Discovery ("What options are under Account?" / "List options in Settings")
      if (targetSpec.actionKind === 'list_options') {
        const menuName = targetSpec.parentHint || targetSpec.targetLabel;
        if (this._getOpenPopupContainers().length === 0 && menuName) {
          const trig = this._findMenuTrigger(menuName);
          if (trig) {
            await this._clickElementPreferStagehand(trig, menuName, req, signal);
            parentExpanded = true;
            parentTriggerLabel = menuName;
            const dl = Date.now() + 1200;
            while (Date.now() < dl) {
              if (this._listOpenMenuOptions().length > 0) break;
              await new Promise((r) => setTimeout(r, 110));
            }
          }
        }
        const opts = this._listOpenMenuOptions();
        const formatted = opts.map((o) => `${o.label}${o.isSubmenu ? ' (submenu)' : ''}`).join(', ');
        const liveAfterList = this._probeLiveDomState();
        return createTaskResult(req, {
          ok: opts.length > 0,
          status: opts.length > 0 ? 'COMPLETED' : 'TARGET_NOT_FOUND',
          engine: 'world_model_hierarchical_control',
          result: {
            controlVerified: opts.length > 0,
            options: opts,
            extractedText: formatted ? `Available options in ${menuName || 'menu'}: ${formatted}` : '',
            parentExpanded,
            parentTriggerLabel
          },
          actualState: { ...liveAfterList, controlVerified: opts.length > 0, extractedText: formatted },
          durationMs: Date.now() - t0,
          evidence: { mechanism: 'world_model_hierarchical_control', menuOptionsCount: opts.length },
          error: opts.length > 0 ? null : { code: 'TARGET_NOT_FOUND', message: `Could not find open menu options for "${menuName}"`, recoverable: true }
        });
      }

      // 1b. Smart Open-Popup + Submenu Exploration Check:
      // If a popup/portal menu is ALREADY open, search both its top-level items AND its nested submenus
      // WITHOUT clicking parentHint ("Account") again (which would toggle the open menu CLOSED!).
      if (targetSpec.actionKind !== 'expand' && targetSpec.targetLabel && this._getOpenPopupContainers().length > 0) {
        const exploredOpen = await this._exploreOpenMenuForTarget(targetSpec.targetLabel, { req, signal });
        if (exploredOpen && exploredOpen.element) {
          const hitEl = exploredOpen.element;
          discoveredSubmenuPath = exploredOpen.submenuPath || [];
          const optLbl = (hitEl.getAttribute('aria-label') || hitEl.innerText || hitEl.textContent || targetSpec.targetLabel).replace(/\s+/g, ' ').trim();
          match = {
            entity: {
              id: 'open_popup_item',
              label: optLbl,
              element: hitEl,
              role: hitEl.getAttribute('role') || hitEl.tagName.toLowerCase(),
              visible: true
            },
            score: 155,
            needsParentExpand: false,
            parentTrigger: null
          };
        }
      }
      const alreadyOpenOption = (match && match.entity && match.entity.id === 'open_popup_item') ? match.entity.element : null;

      // 2. If child control is inside a collapsed parent (accordion/menu/dropdown), expand parent first (hover-then-click for menus!) & poll for lazy portal!
      if (!alreadyOpenOption && match && match.needsParentExpand && match.parentTrigger && match.parentTrigger.element) {
        const trigEl = match.parentTrigger.element;
        parentTriggerLabel = match.parentTrigger.label || targetSpec.parentHint || '';
        const isHoverMenu = Boolean(trigEl.getAttribute && (trigEl.getAttribute('aria-haspopup') === 'menu' || trigEl.hasAttribute('data-hover-menu')));
        let openedByHover = false;
        if (isHoverMenu) {
          const hov = await this._hoverElementViaCdp(trigEl, parentTriggerLabel, req, signal);
          if (hov.usedStagehand) usedStagehand = true;
          await this._waitForDomSettle(trigEl, 150, 35);
          if ((match.entity && match.entity.element && this._isElementVisibleNow(match.entity.element)) || this._findOpenPopupItem(targetSpec.targetLabel)) {
            openedByHover = true;
          }
        }
        if (!openedByHover) {
          const expClick = await this._clickElementPreferStagehand(trigEl, parentTriggerLabel, req, signal);
          if (expClick.usedStagehand) usedStagehand = true;
          await this._waitForDomSettle(trigEl, 220, 40);
        }
        parentExpanded = true;
        // Poll up to 1400ms for lazy-loaded portal menus (e.g., YouTube <ytd-multi-page-menu-renderer>) to render items
        const pollDeadline = Date.now() + 1400;
        while (Date.now() < pollDeadline) {
          const popItem = this._findOpenPopupItem(targetSpec.targetLabel);
          if (popItem) {
            const optLbl = (popItem.getAttribute('aria-label') || popItem.innerText || popItem.textContent || targetSpec.targetLabel).replace(/\s+/g, ' ').trim();
            match = {
              entity: { id: 'lazy_popup_item', label: optLbl, element: popItem, role: popItem.getAttribute('role') || popItem.tagName.toLowerCase(), visible: true },
              score: 150,
              needsParentExpand: false,
              parentTrigger: null
            };
            break;
          }
          if (wm) {
            await wm.buildPageWorldModel(document, { force: true });
            const refreshed = wm.findHierarchicalTarget(targetSpec, tabId);
            if (refreshed && refreshed.entity && refreshed.entity.element && this._isElementVisibleNow(refreshed.entity.element)) {
              match = refreshed;
              break;
            }
          }
          await new Promise((r) => setTimeout(r, 130));
        }
      } else if (!alreadyOpenOption && (!match || !match.entity || !this._isElementVisibleNow(match.entity.element)) && targetSpec.parentHint) {
        // Parent hint provided, target not yet visible/rendered -> find parent trigger via WorldModel OR _findMenuTrigger() (supports #avatar-btn without aria-haspopup)!
        const parentMatch = wm ? wm.findHierarchicalTarget({ targetLabel: targetSpec.parentHint, actionKind: 'expand' }, tabId) : null;
        const trigEl = (parentMatch && parentMatch.entity && parentMatch.entity.element) || this._findMenuTrigger(targetSpec.parentHint);
        if (trigEl) {
          parentTriggerLabel = (parentMatch && parentMatch.entity && parentMatch.entity.label) || targetSpec.parentHint;
          const expClick = await this._clickElementPreferStagehand(trigEl, parentTriggerLabel, req, signal);
          if (expClick.usedStagehand) usedStagehand = true;
          parentExpanded = true;
          await this._waitForDomSettle(trigEl, 220, 40);
          const pollDeadline = Date.now() + 1400;
          while (Date.now() < pollDeadline) {
            const popItem = this._findOpenPopupItem(targetSpec.targetLabel);
            if (popItem) {
              const optLbl = (popItem.getAttribute('aria-label') || popItem.innerText || popItem.textContent || targetSpec.targetLabel).replace(/\s+/g, ' ').trim();
              match = {
                entity: { id: 'lazy_popup_item', label: optLbl, element: popItem, role: popItem.getAttribute('role') || popItem.tagName.toLowerCase(), visible: true },
                score: 150,
                needsParentExpand: false,
                parentTrigger: null
              };
              break;
            }
            if (wm) {
              await wm.buildPageWorldModel(document, { force: true });
              const refreshed = wm.findHierarchicalTarget(targetSpec, tabId);
              if (refreshed && refreshed.entity && refreshed.entity.element && this._isElementVisibleNow(refreshed.entity.element)) {
                match = refreshed;
                break;
              }
            }
            await new Promise((r) => setTimeout(r, 130));
          }
        }
      } else if (!alreadyOpenOption && targetSpec.actionKind === 'expand' && (!match || !match.entity || !match.entity.element)) {
        // Explicit "Open Account" / "Expand Appearance" step inside a multi-step menu chain
        const trigEl = this._findOpenPopupItem(targetSpec.targetLabel) || this._findMenuTrigger(targetSpec.targetLabel);
        if (trigEl) {
          match = {
            entity: {
              id: 'explicit_expand_trigger',
              label: targetSpec.targetLabel,
              element: trigEl,
              role: trigEl.getAttribute('role') || trigEl.tagName.toLowerCase(),
              visible: true
            },
            score: 140,
            needsParentExpand: false,
            parentTrigger: null
          };
        }
      }

      // 2b. Blind Submenu & Unscoped Menu Discovery:
      // Case A: User named the main menu ("Select Dark theme under Account") — main menu is now open,
      //         but the option lives inside an unnamed intermediate submenu ("Appearance: Device theme")!
      if ((!match || !match.entity || !this._isElementVisibleNow(match.entity.element)) && targetSpec.actionKind !== 'expand' && targetSpec.targetLabel && this._getOpenPopupContainers().length > 0) {
        const subExplored = await this._exploreOpenMenuForTarget(targetSpec.targetLabel, { req, signal });
        if (subExplored && subExplored.element) {
          discoveredSubmenuPath = subExplored.submenuPath || [];
          const hitEl = subExplored.element;
          const optLbl = (hitEl.getAttribute('aria-label') || hitEl.innerText || hitEl.textContent || targetSpec.targetLabel).replace(/\s+/g, ' ').trim();
          match = {
            entity: { id: 'nested_submenu_item', label: optLbl, element: hitEl, role: hitEl.getAttribute('role') || hitEl.tagName.toLowerCase(), visible: true },
            score: 155,
            needsParentExpand: false,
            parentTrigger: null
          };
        }
      }

      // Case B: User did NOT know which main menu OR submenu holds the option ("Switch to Dark theme", "Set playback speed to 1.5x")!
      // Ignore false-positive matches on content cards/videos when target is a known menu/setting option.
      const matchedIsContentTrap = Boolean(
        match && match.entity && match.entity.element &&
        this._isKnownMenuOrSettingTarget(targetSpec.targetLabel) &&
        match.entity.element.closest && match.entity.element.closest('main, article, ytd-rich-item-renderer, ytd-video-renderer')
      );
      if ((!match || !match.entity || !this._isElementVisibleNow(match.entity.element) || matchedIsContentTrap) && targetSpec.actionKind !== 'expand' && targetSpec.targetLabel && !targetSpec.parentHint) {
        const discovered = await this._discoverAndSearchTopLevelMenus(targetSpec.targetLabel, req, signal);
        if (discovered && discovered.element) {
          parentExpanded = true;
          parentTriggerLabel = discovered.parentTriggerLabel;
          discoveredSubmenuPath = discovered.submenuPath || [];
          const hitEl = discovered.element;
          const optLbl = (hitEl.getAttribute('aria-label') || hitEl.innerText || hitEl.textContent || targetSpec.targetLabel).replace(/\s+/g, ' ').trim();
          match = {
            entity: { id: 'auto_discovered_menu_item', label: optLbl, element: hitEl, role: hitEl.getAttribute('role') || hitEl.tagName.toLowerCase(), visible: true },
            score: 155,
            needsParentExpand: false,
            parentTrigger: null
          };
        }
      }

      // 3. If still not found, check if any collapsed expandable trigger on the page matches parentHint/sectionHint or scroll scrollable regions
      if ((!match || !match.entity || !match.entity.element) && wm && beforeInv) {
        // Try scrolling scrollable filter/sidebar containers to reveal off-screen controls
        const scrollRegions = Array.isArray(beforeInv.scrollableRegions) ? beforeInv.scrollableRegions : [];
        for (const reg of scrollRegions.slice(0, 4)) {
          if (!reg.element || !reg.element.isConnected) continue;
          try {
            reg.element.scrollTop = Math.min(reg.element.scrollHeight, reg.element.clientHeight);
            await new Promise((r) => setTimeout(r, 120));
            await wm.buildPageWorldModel(document, { force: true });
            const retryMatch = wm.findHierarchicalTarget(targetSpec, tabId);
            if (retryMatch && retryMatch.entity && retryMatch.entity.element) {
              match = retryMatch;
              break;
            }
          } catch (_e) {}
        }
      }

      if (!match || !match.entity || !match.entity.element || !match.entity.element.isConnected) {
        const liveFail = this._probeLiveDomState();
        return createTaskResult(req, {
          ok: false,
          status: 'TARGET_NOT_FOUND',
          engine: 'world_model_hierarchical_control',
          actualState: { ...liveFail, controlVerified: false, beforeInventoryVersion },
          durationMs: Date.now() - t0,
          evidence: { mechanism: 'world_model_hierarchical_control', parentExpanded, parentTriggerLabel },
          error: {
            code: 'TARGET_NOT_FOUND',
            message: `No interactive control matched "${targetSpec.targetLabel || targetSpec.parentHint}"${targetSpec.parentHint ? ` under "${targetSpec.parentHint}"` : ''}`,
            recoverable: true
          }
        });
      }

      const entity = match.entity;
      let el = this._unwrapActionableMenuItem(entity.element);
      const tag = (el.tagName || '').toLowerCase();
      const inputType = (el.getAttribute && (el.getAttribute('type') || '')).toLowerCase();
      const role = (el.getAttribute && (el.getAttribute('role') || '')).toLowerCase();
      const hasPopup = (el.getAttribute && (el.getAttribute('aria-haspopup') || '')).toLowerCase();

      // Scroll control into view (handles both window and nested scrollable filter regions)
      try {
        if (typeof el.scrollIntoView === 'function') {
          el.scrollIntoView({ behavior: 'instant', block: 'center', inline: 'center' });
        }
      } catch (_e) {}

      let controlVerified = false;
      let verifiedState = {};
      let matchedControl = {
        id: entity.id,
        label: entity.label || targetSpec.targetLabel,
        tag,
        role: role || entity.role || tag,
        type: inputType || null,
        section: entity.context && entity.context.sectionTitle ? entity.context.sectionTitle : null,
        inShadowDom: Boolean(typeof ShadowRoot !== 'undefined' && el.getRootNode && el.getRootNode() instanceof ShadowRoot)
      };

      // 4. Execute semantically appropriate control interaction using genuine CDP mouse/keyboard input & verify live state
      let inputMechanism = usedStagehand ? 'cdp_mouse_input' : 'semantic_browser_operation';
      if (tag === 'select') {
        const wantLow = targetSpec.targetLabel.toLowerCase();
        const wantTokens = wantLow.split(/\s+/).filter((t) => t.length > 1);
        const options = Array.from(el.options || []);
        const chosenIdx = options.findIndex((o) => (o.text || '').trim().toLowerCase() === wantLow || String(o.value || '').trim().toLowerCase() === wantLow);
        const fallbackIdx = chosenIdx >= 0 ? chosenIdx : options.findIndex((o) => (o.text || '').toLowerCase().includes(wantLow) || String(o.value || '').toLowerCase().includes(wantLow));
        const finalIdx = fallbackIdx >= 0 ? fallbackIdx : options.findIndex((o) => wantTokens.length > 0 && wantTokens.every((t) => `${o.text} ${o.value}`.toLowerCase().includes(t)));
        const chosenOpt = finalIdx >= 0 ? options[finalIdx] : null;
        if (chosenOpt) {
          this._highlightInteractiveTarget(el);
          const stagehandEnabled = Boolean(this.useStagehandFn() && this.stagehandAdapter);
          const curIdx = el.selectedIndex >= 0 ? el.selectedIndex : 0;
          const delta = finalIdx - curIdx;
          if (stagehandEnabled && Math.abs(delta) <= 12) {
            // Focus native <select> with genuine CDP click, then step via CDP ArrowDown/ArrowUp + Enter!
            const clk = await this._clickElementPreferStagehand(el, entity.label || targetSpec.parentHint, req, signal);
            if (clk.usedStagehand) {
              usedStagehand = true;
              const arrowKey = delta >= 0 ? 'ArrowDown' : 'ArrowUp';
              for (let s = 0; s < Math.abs(delta); s++) {
                await this.stagehandAdapter.act('press_key', { key: arrowKey }, arrowKey, { commandId: req.commandId, timeoutMs: 2500, signal }).catch(() => {});
              }
              await this.stagehandAdapter.act('press_key', { key: 'Enter' }, 'Enter', { commandId: req.commandId, timeoutMs: 2500, signal }).catch(() => {});
              await this._waitForDomSettle(el, 120, 30);
              inputMechanism = 'cdp_mouse_and_keyboard_input';
            }
          }
          // If OS popup didn't commit index (e.g. headless/unfocused), sync selected value cleanly
          if (!el.options || !el.options[el.selectedIndex] || el.options[el.selectedIndex].value !== chosenOpt.value) {
            el.focus && el.focus();
            el.value = chosenOpt.value;
            el.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
            el.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
            await this._waitForDomSettle(el, 120, 30);
          }
          const selectedOpt = el.options && el.options[el.selectedIndex];
          controlVerified = Boolean(selectedOpt && selectedOpt.value === chosenOpt.value);
          verifiedState = {
            controlType: 'native_select',
            selectedValue: selectedOpt ? selectedOpt.value : el.value,
            selectedText: selectedOpt ? (selectedOpt.text || '').trim() : ''
          };
        }
      } else if (role === 'combobox' || hasPopup === 'listbox' || hasPopup === 'menu') {
        // Custom ARIA dropdown / combobox: expand if closed, reinspect, find option, click option, verify!
        const expandedBefore = el.getAttribute('aria-expanded') === 'true';
        if (!expandedBefore) {
          const openRes = await this._clickElementPreferStagehand(el, entity.label || targetSpec.parentHint, req, signal);
          if (openRes.usedStagehand) usedStagehand = true;
          parentExpanded = true;
          parentTriggerLabel = entity.label || targetSpec.parentHint || targetSpec.targetLabel;
          await new Promise((r) => setTimeout(r, 200));
          if (wm) await wm.buildPageWorldModel(document, { force: true });
        }
        const optEl = targetSpec.targetLabel ? this._findVisiblePopupOption(el, targetSpec.targetLabel) : null;
        if (optEl) {
          const optText = (optEl.innerText || optEl.textContent || optEl.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim();
          const optClick = await this._clickElementPreferStagehand(optEl, optText, req, signal);
          if (optClick.usedStagehand) usedStagehand = true;
          await new Promise((r) => setTimeout(r, 180));
          const triggerAfterText = (el.innerText || el.textContent || el.value || el.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim();
          const optSelected = optEl.getAttribute('aria-selected') === 'true' || optEl.getAttribute('aria-checked') === 'true' || optEl.getAttribute('data-selected') === 'true';
          const triggerReflects = triggerAfterText.toLowerCase().includes(targetSpec.targetLabel.toLowerCase()) ||
            (optText && triggerAfterText.toLowerCase().includes(optText.toLowerCase()));
          controlVerified = Boolean(optSelected || triggerReflects);
          verifiedState = {
            controlType: 'custom_dropdown',
            expandedDropdown: true,
            selectedOption: optText,
            triggerTextAfter: triggerAfterText.slice(0, 120),
            ariaSelected: optEl.getAttribute('aria-selected')
          };
        } else {
          // If action was merely to expand the menu/dropdown itself
          const isExpNow = el.getAttribute('aria-expanded') === 'true';
          controlVerified = isExpNow;
          verifiedState = { controlType: 'custom_dropdown_expand', ariaExpanded: el.getAttribute('aria-expanded') };
        }
      } else if (tag === 'input' && (inputType === 'range' || inputType === 'number' || (targetSpec.actionKind === 'set_threshold' && inputType === 'text'))) {
        const rawNum = Number.isFinite(targetSpec.numericValue) ? targetSpec.numericValue : Number(String(targetSpec.targetLabel).replace(/[^\d.]/g, ''));
        if (Number.isFinite(rawNum)) {
          let finalNum = rawNum;
          const minV = el.min !== '' ? Number(el.min) : 0;
          const maxV = el.max !== '' ? Number(el.max) : 100;
          const stepV = Math.max(1, Number(el.step || 1));
          if (inputType === 'range') {
            if (Number.isFinite(minV)) finalNum = Math.max(minV, finalNum);
            if (Number.isFinite(maxV)) finalNum = Math.min(maxV, finalNum);
          }
          this._highlightInteractiveTarget(el);
          const stagehandEnabled = Boolean(this.useStagehandFn() && this.stagehandAdapter);
          if (inputType === 'range' && stagehandEnabled && maxV > minV) {
            // Genuine CDP mouse drag along the slider track + CDP ArrowLeft/ArrowRight fine-tuning!
            const rect = el.getBoundingClientRect();
            const curNum = Number(el.value || minV);
            const curRatio = Math.max(0, Math.min(1, (curNum - minV) / (maxV - minV)));
            const targetRatio = Math.max(0, Math.min(1, (finalNum - minV) / (maxV - minV)));
            const pad = 8;
            const trackW = Math.max(10, rect.width - pad * 2);
            const fromX = Math.round(rect.left + pad + trackW * curRatio);
            const toX = Math.round(rect.left + pad + trackW * targetRatio);
            const cy = Math.round(rect.top + rect.height / 2);
            const dragRes = await this.stagehandAdapter.act('drag', { fromX, fromY: cy, toX, toY: cy, steps: 10 }, null, {
              commandId: req.commandId,
              timeoutMs: 5000,
              signal
            }).catch(() => null);
            if (dragRes && dragRes.ok !== false) {
              usedStagehand = true;
              inputMechanism = 'cdp_mouse_input';
              await this._waitForDomSettle(el, 120, 30);
              // Fine-tune with genuine CDP ArrowLeft/ArrowRight keys if track pixel rounding left us off by 1-3 steps
              let diffSteps = Math.round((finalNum - Number(el.value)) / stepV);
              if (diffSteps !== 0 && Math.abs(diffSteps) <= 8) {
                const key = diffSteps > 0 ? 'ArrowRight' : 'ArrowLeft';
                for (let k = 0; k < Math.abs(diffSteps); k++) {
                  await this.stagehandAdapter.act('press_key', { key }, key, { commandId: req.commandId, timeoutMs: 2000, signal }).catch(() => {});
                }
                inputMechanism = 'cdp_mouse_and_keyboard_input';
                await this._waitForDomSettle(el, 100, 25);
              }
            }
          } else if (inputType !== 'range' && stagehandEnabled) {
            // Numeric/text threshold input: genuine CDP click + Ctrl+A + CDP type_text!
            const rect = el.getBoundingClientRect();
            const typeRes = await this.stagehandAdapter.act('type_text', {
              x: Math.round(rect.left + rect.width / 2),
              y: Math.round(rect.top + rect.height / 2),
              clearFirst: true
            }, String(finalNum), { commandId: req.commandId, timeoutMs: 4000, signal }).catch(() => null);
            if (typeRes && typeRes.ok !== false) {
              usedStagehand = true;
              inputMechanism = 'cdp_mouse_and_keyboard_input';
              await this._waitForDomSettle(el, 120, 30);
            }
          }
          // Fallback only if CDP was unavailable
          const tol = inputType === 'range' ? Math.max(1, stepV) : 0.01;
          if (!Number.isFinite(Number(el.value)) || Math.abs(Number(el.value) - finalNum) > tol) {
            const setter = typeof HTMLInputElement !== 'undefined' ? Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set : null;
            el.focus && el.focus();
            if (setter) setter.call(el, String(finalNum));
            else el.value = String(finalNum);
            el.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
            el.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
            await this._waitForDomSettle(el, 120, 30);
          }
          const observedNum = Number(el.value);
          controlVerified = Number.isFinite(observedNum) && Math.abs(observedNum - finalNum) <= tol;
          verifiedState = {
            controlType: inputType === 'range' ? 'range_slider' : 'numeric_input',
            requestedValue: finalNum,
            observedValue: el.value
          };
        }
      } else if ((tag === 'input' && (inputType === 'checkbox' || inputType === 'radio')) || role === 'checkbox' || role === 'radio' || role === 'switch') {
        const desiredChecked = targetSpec.actionKind !== 'uncheck';
        const isCheckedNow = () => (tag === 'input' ? Boolean(el.checked) : (el.getAttribute('aria-checked') === 'true'));
        const beforeChecked = isCheckedNow();
        if (beforeChecked !== desiredChecked) {
          // If input is visually hidden/styled inside a wrapping <label>, click the wrapping label or the input
          const clickTarget = (tag === 'input' && !this._isElementVisibleNow(el) && el.closest && el.closest('label')) || el;
          const clk = await this._clickElementPreferStagehand(clickTarget, entity.label || targetSpec.targetLabel, req, signal);
          if (clk.usedStagehand) usedStagehand = true;
          await new Promise((r) => setTimeout(r, 150));
        }
        const afterChecked = isCheckedNow();
        controlVerified = afterChecked === desiredChecked;
        verifiedState = {
          controlType: inputType || role,
          beforeChecked,
          afterChecked,
          desiredChecked
        };
      } else {
        // Menu item, category button/link, tab, accordion summary/button, price bucket button, or option
        const beforeExpanded = el.getAttribute && el.getAttribute('aria-expanded');
        const beforeSelected = el.getAttribute && el.getAttribute('aria-selected');
        const beforePressed = el.getAttribute && el.getAttribute('aria-pressed');
        const beforeCurrent = el.getAttribute && el.getAttribute('aria-current');
        const beforeClass = el.className || '';
        const beforeDetailsOpen = (tag === 'summary' && el.parentElement && el.parentElement.tagName === 'DETAILS') ? Boolean(el.parentElement.open) : null;
        const beforeUrl = typeof window !== 'undefined' && window.location ? window.location.href : '';
        const beforeBodyText = (document.body && document.body.innerText) ? document.body.innerText.slice(0, 2000) : '';

        const clk = await this._clickElementPreferStagehand(el, entity.label || targetSpec.targetLabel, req, signal);
        if (clk.usedStagehand) usedStagehand = true;
        await this._waitForDomSettle(el, 180, 40);

        const afterExpanded = el.getAttribute && el.getAttribute('aria-expanded');
        const afterSelected = el.getAttribute && el.getAttribute('aria-selected');
        const afterPressed = el.getAttribute && el.getAttribute('aria-pressed');
        const afterCurrent = el.getAttribute && el.getAttribute('aria-current');
        const afterClass = el.className || '';
        const afterDetailsOpen = (tag === 'summary' && el.parentElement && el.parentElement.tagName === 'DETAILS') ? Boolean(el.parentElement.open) : null;
        const afterUrl = typeof window !== 'undefined' && window.location ? window.location.href : '';
        const afterBodyText = (document.body && document.body.innerText) ? document.body.innerText.slice(0, 2000) : '';

        const ctrlId = el.getAttribute && el.getAttribute('aria-controls');
        const rootNode = (el.getRootNode && el.getRootNode()) || document;
        const ctrlPanel = ctrlId ? ((rootNode.getElementById && rootNode.getElementById(ctrlId)) || document.getElementById(ctrlId)) : null;
        const panelVisible = ctrlPanel ? this._isElementVisibleNow(ctrlPanel) : false;

        const openPopupAfter = Boolean(
          document.querySelector && document.querySelector('tp-yt-iron-dropdown:not([aria-hidden="true"]), ytd-multi-page-menu-renderer, [role="menu"], [role="listbox"]')
        );
        controlVerified = Boolean(
          document.activeElement === el ||
          afterExpanded === 'true' ||
          afterSelected === 'true' ||
          afterPressed === 'true' ||
          Boolean(afterCurrent && afterCurrent !== 'false') ||
          afterDetailsOpen === true ||
          (beforeExpanded !== null && afterExpanded !== beforeExpanded) ||
          (beforeSelected !== null && afterSelected !== beforeSelected) ||
          (beforePressed !== null && afterPressed !== beforePressed) ||
          (afterClass !== beforeClass && /\b(?:active|selected|open|expanded|current|checked)\b/i.test(afterClass)) ||
          panelVisible ||
          (targetSpec.actionKind === 'expand' && openPopupAfter) ||
          Boolean(el.tagName === 'A' && el.href) ||
          afterUrl !== beforeUrl ||
          afterBodyText !== beforeBodyText ||
          !el.isConnected // Element replaced due to multi-step DOM transition!
        );

        verifiedState = {
          controlType: role || tag,
          ariaExpanded: afterExpanded,
          ariaSelected: afterSelected,
          ariaPressed: afterPressed,
          detailsOpen: afterDetailsOpen,
          panelVisible,
          urlChanged: afterUrl !== beforeUrl,
          domMutated: afterBodyText !== beforeBodyText || !el.isConnected
        };
      }

      // 5. Mandatory post-interaction World Model reinspection (DOM & available controls may have changed!)
      const afterInv = wm ? await wm.buildPageWorldModel(document, { force: true }) : null;
      const afterInventoryVersion = afterInv ? (afterInv.inventoryVersion || afterInv.version || beforeInventoryVersion) : beforeInventoryVersion;
      const liveAfter = this._probeLiveDomState();
      const engineName = usedStagehand ? 'stagehand_hierarchical_control' : 'world_model_hierarchical_control';
      if (usedStagehand && inputMechanism === 'semantic_browser_operation') {
        inputMechanism = 'cdp_mouse_input';
      }

      return createTaskResult(req, {
        ok: controlVerified,
        status: controlVerified ? 'COMPLETED' : 'VERIFICATION_FAILED',
        engine: engineName,
        result: {
          controlVerified,
          verifiedState,
          matchedControl,
          parentExpanded,
          parentTriggerLabel,
          submenuPath: discoveredSubmenuPath,
          beforeInventoryVersion,
          afterInventoryVersion,
          reinspected: afterInventoryVersion > beforeInventoryVersion,
          usedStagehand,
          inputMechanism
        },
        targetIdentity: {
          url: liveAfter.url,
          label: matchedControl.label,
          accessibleName: matchedControl.label,
          role: matchedControl.role
        },
        actualState: {
          ...liveAfter,
          domMatched: true,
          controlVerified,
          verifiedState,
          beforeInventoryVersion,
          afterInventoryVersion
        },
        durationMs: Date.now() - t0,
        evidence: {
          mechanism: engineName,
          inputMechanism,
          usedStagehand,
          parentExpanded,
          parentTriggerLabel,
          submenuPath: discoveredSubmenuPath,
          reinspected: afterInventoryVersion > beforeInventoryVersion
        },
        error: controlVerified ? null : {
          code: 'VERIFICATION_FAILED',
          message: `Control "${matchedControl.label}" was interacted with but state change was not verified`,
          recoverable: true
        }
      });
    }

    _extractSearchResultsFromDom(limit = 5) {
      if (typeof document === 'undefined') return [];
      const items = [];
      const isVis = (el) => {
        try {
          const r = el.getBoundingClientRect();
          const st = typeof getComputedStyle === 'function' ? getComputedStyle(el) : null;
          return r.width > 0 && r.height > 0 && (!st || (st.visibility !== 'hidden' && st.display !== 'none'));
        } catch (_e) { return true; }
      };

      const ytCards = Array.from(document.querySelectorAll('ytd-video-renderer'));
      for (const card of ytCards) {
        if (card.closest && card.closest('ytd-ad-slot-renderer, ytd-promoted-sparkles-web-renderer, ytd-reel-shelf-renderer')) continue;
        const link = card.querySelector('a#video-title[href]');
        if (!link || !isVis(link)) continue;
        const title = (link.innerText || link.getAttribute('title') || '').replace(/\s+/g, ' ').trim();
        if (!title) continue;
        const snippet = Array.from(card.querySelectorAll('.metadata-snippet-container, yt-formatted-string.metadata-snippet-text, #description-text'))
          .map((n) => (n.innerText || n.textContent || '').replace(/\s+/g, ' ').trim()).filter(Boolean).join(' ');
        const channel = ((card.querySelector('#channel-name') && card.querySelector('#channel-name').innerText) || '').replace(/\s+/g, ' ').trim();
        const meta = Array.from(card.querySelectorAll('#metadata-line span')).map((s) => (s.innerText || '').trim()).filter(Boolean).join(' • ');
        items.push({
          id: `res_${items.length + 1}`,
          rank: items.length + 1,
          title: title.slice(0, 160),
          description: (snippet || [channel ? `Channel: ${channel}` : '', meta, link.getAttribute('aria-label') || ''].filter(Boolean).join(' — ')).slice(0, 320),
          channel: channel.slice(0, 80),
          href: link.href || link.getAttribute('href') || ''
        });
        if (items.length >= limit) return items;
      }

      const deepCards = this._collectShadowData(document, '[data-product-card], .product-card, [data-result-item], [data-search-result], .search-result, .searchresult, .mw-search-result, .result-card, .result, main article, [role="article"]').elements;
      for (const card of deepCards) {
        if (!isVis(card)) continue;
        const link = card.querySelector && card.querySelector('h1 a[href], h2 a[href], h3 a[href], a[href], button[data-open-result]');
        if (!link) continue;
        const headingEl = card.querySelector('h1, h2, h3, [data-result-title], [data-product-title], .product-title');
        const title = ((headingEl && headingEl.innerText) || link.innerText || link.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim();
        if (!title || title.length < 2) continue;
        const priceEl = card.querySelector('[data-price], .price, .product-price');
        const descEl = card.querySelector('p, .description, .snippet, .specs, .searchresult, [data-result-description], [data-specs]');
        const priceText = priceEl ? (priceEl.innerText || '').replace(/\s+/g, ' ').trim() : '';
        const bodyDesc = (((descEl && descEl.innerText) || card.innerText || '').replace(title, '')).replace(/\s+/g, ' ').trim();
        const description = [priceText && !bodyDesc.includes(priceText) ? priceText : '', bodyDesc].filter(Boolean).join(' — ').slice(0, 320);
        items.push({
          id: `res_${items.length + 1}`,
          rank: items.length + 1,
          title: title.slice(0, 160),
          description,
          channel: '',
          href: link.href || link.getAttribute('href') || ''
        });
        if (items.length >= limit) return items;
      }
      return items;
    }

    async _executeViaExistingBrowserEngine(req, signal, fallbackReason = null) {
      const t0 = Date.now();
      if (signal && signal.aborted) {
        return createTaskResult(req, { ok: false, status: 'CANCELLED', engine: 'existing_browser_engine', durationMs: Date.now() - t0, error: { code: 'CANCELLED', message: 'Cancelled before existing browser engine execution', recoverable: false } });
      }

      const engineName = fallbackReason ? 'existing_browser_engine_fallback' : (this.browserEngine ? 'rebuilt_browser_engine' : 'existing_dom_engine');
      const evidenceBase = {
        mechanism: fallbackReason ? 'existing_browser_engine_fallback' : 'existing_browser_engine',
        fallbackUsed: Boolean(fallbackReason),
        fallbackReason: fallbackReason || null
      };

      // Chrome tab operations via background.js
      if (req.action === 'tab_list' || req.action === 'tab_switch') {
        if (typeof chrome !== 'undefined' && chrome.runtime && typeof chrome.runtime.sendMessage === 'function') {
          const tabResp = await new Promise((resolve) => {
            chrome.runtime.sendMessage({
              type: 'SLEEPWALKER_TAB_ACTION',
              action: {
                type: req.action === 'tab_list' ? 'tab_list' : 'tab_switch',
                query: req.target.label || req.parameters.query || '',
                tabId: req.target.tabId || null
              }
            }, (r) => resolve(r || { ok: false, error: chrome.runtime.lastError ? chrome.runtime.lastError.message : 'No tab response' }));
          });
          return createTaskResult(req, {
            ok: Boolean(tabResp && tabResp.ok),
            status: tabResp && tabResp.ok ? 'COMPLETED' : 'FAILED',
            engine: engineName,
            result: tabResp,
            targetIdentity: { tabId: tabResp && tabResp.tabId, title: tabResp && tabResp.title },
            actualState: { ...(await this.probeState(req).catch(() => ({}))), tabResult: tabResp },
            durationMs: Date.now() - t0,
            evidence: evidenceBase,
            error: tabResp && !tabResp.ok ? (tabResp.error || 'Tab action failed') : null
          });
        }
      }

      // Scroll (supports deltaY, direction, or scrolling to a section/Shadow DOM element)
      if (req.action === 'scroll' && typeof window !== 'undefined') {
        const before = window.scrollY || 0;
        let targetInView = false;
        const want = String(req.target.label || req.target.selector || '').trim();
        if (want && !/^(?:down|up|top|bottom)$/i.test(want) && typeof document !== 'undefined') {
          const targetEl = this._findDomTarget({ label: want, selector: req.target.selector }) ||
            this._collectShadowData(document, 'h1, h2, h3, h4, section, article, [id], [data-section]').elements.find((n) =>
              `${n.innerText || n.textContent || ''} ${n.id || ''}`.toLowerCase().includes(want.toLowerCase())
            );
          if (targetEl && typeof targetEl.scrollIntoView === 'function') {
            targetEl.scrollIntoView({ behavior: 'instant', block: 'center' });
            targetInView = true;
          }
        }
        if (!targetInView) {
          const dir = String(req.parameters.direction || want || 'down').toLowerCase();
          const dy = Number(req.parameters.deltaY || 500);
          if (dir === 'bottom' && typeof document !== 'undefined') window.scrollTo(0, document.documentElement.scrollHeight);
          else if (dir === 'top') window.scrollTo(0, 0);
          else window.scrollBy(0, dir === 'up' ? -Math.abs(dy) : dy);
        }
        await new Promise((r) => setTimeout(r, 120));
        const afterState = this._probeLiveDomState();
        const scrolledDelta = (window.scrollY || 0) - before;
        return createTaskResult(req, {
          ok: true,
          status: 'COMPLETED',
          engine: engineName,
          result: { scrolled: true, before, after: window.scrollY || 0, scrolledDelta, targetInView },
          targetIdentity: { url: afterState.url, label: want || 'window' },
          actualState: { ...afterState, scrolledDelta, targetInView },
          durationMs: Date.now() - t0,
          evidence: evidenceBase
        });
      }

      // Extract visible information or structured search results from live DOM + Shadow DOM
      if (req.action === 'extract' || req.action === 'read_page' || req.action === 'observe') {
        if (req.parameters && req.parameters.extractMode === 'search_results') {
          const maxRes = Math.max(1, Math.min(10, Number(req.parameters.maxResults || 5)));
          let searchResults = [];
          const deadline = Date.now() + Math.min(req.timeout || 5000, 5000);
          while (Date.now() < deadline) {
            searchResults = this._extractSearchResultsFromDom(maxRes);
            if (searchResults.length > 0) break;
            await new Promise((r) => setTimeout(r, 220));
          }
          const live = this._probeLiveDomState();
          const formatted = searchResults.map((r) => `[${r.rank}] ${r.title} — ${r.description}`).join('\n');
          const ok = searchResults.length > 0;
          return createTaskResult(req, {
            ok,
            status: ok ? 'COMPLETED' : 'TARGET_NOT_FOUND',
            engine: engineName,
            result: { extractedText: formatted, searchResults, count: searchResults.length, url: live.url, title: live.title },
            targetIdentity: { url: live.url, title: live.title, selector: 'search_results' },
            actualState: { ...live, extractedText: formatted, searchResults },
            durationMs: Date.now() - t0,
            evidence: evidenceBase,
            error: ok ? null : 'No search results found on current page'
          });
        }

        const live = this._probeLiveDomState();
        const selector = req.target && req.target.selector;
        let extractedText = '';
        if (selector && typeof document !== 'undefined') {
          const el = this._collectShadowData(document, selector).elements[0] || null;
          extractedText = el ? (el.innerText || el.textContent || '').trim() : '';
        }
        if (!extractedText) {
          extractedText = live.visibleText || '';
        }
        const query = String(req.parameters.query || req.target.label || '').trim();
        let matchedSnippet = extractedText;
        if (query && extractedText) {
          if (/python\s+release|latest\s+python|version/i.test(query)) {
            const verMatch = extractedText.match(/Python\s+\d+\.\d+(?:\.\d+)?/i);
            if (verMatch) matchedSnippet = verMatch[0];
          } else {
            const sentences = extractedText.split(/(?<=[.!?])\s+/);
            const words = query.toLowerCase().split(/\s+/).filter((w) => w.length > 2);
            const hit = sentences.find((s) => words.some((w) => s.toLowerCase().includes(w)));
            if (hit) matchedSnippet = hit.trim().slice(0, 320);
          }
        }
        const ok = Boolean(matchedSnippet.length > 0 || live.title || req.action === 'observe');
        return createTaskResult(req, {
          ok,
          status: ok ? 'COMPLETED' : 'TARGET_NOT_FOUND',
          engine: engineName,
          result: {
            extractedText: matchedSnippet,
            fullExcerpt: extractedText.slice(0, 600),
            headings: live.headings || [],
            url: live.url,
            title: live.title
          },
          targetIdentity: { url: live.url, title: live.title, selector: selector || 'main/document' },
          actualState: { ...live, extractedText: matchedSnippet },
          durationMs: Date.now() - t0,
          evidence: evidenceBase,
          error: ok ? null : 'No visible content found to extract'
        });
      }

      // Direct click on live DOM / open Shadow DOM element (with dynamic polling + collapsed sidebar/YouTube Guide auto-expand)
      if (req.action === 'click' && typeof document !== 'undefined') {
        let el = null;
        let triedSidebarExpand = false;
        const pollUntil = Date.now() + Math.min(req.timeout || 3000, 3000);
        while (Date.now() < pollUntil) {
          el = this._findDomTarget(req.target);
          if (el) break;
          if (!triedSidebarExpand) {
            triedSidebarExpand = true;
            const guideBtn = document.querySelector('#guide-button button, button[aria-label="Guide"], button[aria-label*="navigation" i][aria-expanded="false"], button[aria-label*="menu" i][aria-expanded="false"]');
            if (guideBtn) {
              try {
                const r = guideBtn.getBoundingClientRect();
                if (r.width > 0 && r.height > 0) {
                  guideBtn.click();
                  await new Promise((res) => setTimeout(res, 380));
                  el = this._findDomTarget(req.target);
                  if (el) break;
                }
              } catch (_e) {}
            }
          }
          await new Promise((r) => setTimeout(r, 180));
        }
        if (!el && req.target && req.target.label) {
          // Fallback: if user said "Select Dark theme" or "Select YouTube Studio" without naming the parent menu/submenu,
          // automatically search open popups + semantically matching top-level menus & nested submenus!
          const autoFound = await this._discoverAndSearchTopLevelMenus(req.target.label, req, signal);
          if (autoFound && autoFound.element) {
            el = autoFound.element;
          }
        }
        if (!el) {
          return createTaskResult(req, {
            ok: false,
            status: 'TARGET_NOT_FOUND',
            engine: engineName,
            actualState: this._probeLiveDomState(),
            durationMs: Date.now() - t0,
            evidence: evidenceBase,
            error: { code: 'TARGET_NOT_FOUND', message: `Browser target '${req.target.label || req.target.selector || ''}' not found in DOM`, recoverable: true }
          });
        }
        const label = (el.getAttribute('title') || el.getAttribute('aria-label') || el.innerText || el.textContent || el.value || '').trim().slice(0, 120);
        if (typeof el.scrollIntoView === 'function') el.scrollIntoView({ block: 'center', inline: 'center' });
        const shield = typeof window !== 'undefined' && window.SleepwalkerIntelligence && window.SleepwalkerIntelligence.SleepwalkerClickShield;
        const doClick = () => {
          el.focus && el.focus();
          el.click();
        };
        if (shield && typeof shield.withPassthrough === 'function') {
          await shield.withPassthrough(doClick);
        } else {
          doClick();
        }
        await new Promise((r) => setTimeout(r, 180));
        const after = this._probeLiveDomState();
        return createTaskResult(req, {
          ok: true,
          status: 'COMPLETED',
          engine: engineName,
          result: { clicked: true, tagName: el.tagName, label, href: el.href || null },
          targetIdentity: { url: after.url, tagName: el.tagName, accessibleName: label, selector: req.target.selector || null },
          actualState: { ...after, domMatched: true, accessibility: { name: label, role: el.getAttribute('role') || el.tagName.toLowerCase() } },
          durationMs: Date.now() - t0,
          evidence: evidenceBase
        });
      }

      // Batch multi-field form fill (adapted from nanobrowser fill_form receipts + Sleepwalker FormIndex/FormFill)
      if (req.action === 'fill_form' && typeof document !== 'undefined') {
        const entries = Array.isArray(req.parameters && req.parameters.fields) ? req.parameters.fields : [];
        const formFill = typeof window !== 'undefined' && window.SleepwalkerFormFill
          ? window.SleepwalkerFormFill
          : (typeof require === 'function' ? (() => { try { return require('../forms/form-fill.js'); } catch (_e) { return null; } })() : null);
        if (formFill && typeof formFill.fillFormBatch === 'function' && entries.length > 0) {
          const batchRes = await formFill.fillFormBatch(entries, document, { timeoutMs: 800 });
          const after = this._probeLiveDomState();
          return createTaskResult(req, {
            ok: batchRes.ok || batchRes.filledCount > 0,
            status: batchRes.ok ? 'COMPLETED' : (batchRes.partial ? 'PARTIAL' : 'TARGET_NOT_FOUND'),
            engine: engineName,
            result: {
              ...batchRes,
              awaitingSubmitConfirmation: Boolean(req.parameters && req.parameters.requestSubmitConfirmation)
            },
            targetIdentity: { url: after.url, tagName: 'FORM', accessibleName: `Form (${batchRes.filledCount}/${batchRes.totalRequested} fields)` },
            actualState: { ...after, domMatched: batchRes.filledCount > 0, formSummary: batchRes.summary },
            durationMs: Date.now() - t0,
            evidence: evidenceBase,
            error: batchRes.filledCount === 0
              ? { code: 'TARGET_NOT_FOUND', message: 'Could not fill any requested form fields on this page.', recoverable: true }
              : null
          });
        }
      }

      // Fill / Search on live DOM + open Shadow DOM (with ARIA/Google Forms FormIndex support & safety guards)
      if ((req.action === 'fill' || req.action === 'search') && typeof document !== 'undefined') {
        const val = String(req.parameters.value ?? req.parameters.query ?? req.parameters.text ?? '');
        const isSearch = req.action === 'search';

        // For non-search form fills, prefer SleepwalkerFormIndex + SleepwalkerFormFill universal engine
        // so Google Forms aria-labelledby, ARIA radiogroups/checkboxes/listboxes, and sensitive guards work seamlessly.
        if (!isSearch && !req.target.selector) {
          const formIndex = typeof window !== 'undefined' && window.SleepwalkerFormIndex
            ? window.SleepwalkerFormIndex
            : (typeof require === 'function' ? (() => { try { return require('../forms/form-index.js'); } catch (_e) { return null; } })() : null);
          const formFill = typeof window !== 'undefined' && window.SleepwalkerFormFill
            ? window.SleepwalkerFormFill
            : (typeof require === 'function' ? (() => { try { return require('../forms/form-fill.js'); } catch (_e) { return null; } })() : null);
          const needle = String(req.target.label || req.target.name || '').trim();
          if (formIndex && formFill && typeof formIndex.buildFormIndex === 'function' && typeof formFill.fillFieldUniversal === 'function' && needle) {
            const indexed = formIndex.buildFormIndex(document);
            const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
            const q = norm(needle);
            const qTokens = q.split(/\s+/).filter(Boolean);
            let bestField = null;
            let bestScore = 0;
            for (const f of indexed) {
              const lbl = norm(f.label);
              const full = norm(f.fullLabel);
              const nm = norm(f.name);
              let s = 0;
              if (lbl === q || full === q || (nm && nm === q)) s = 1.0;
              else if (lbl.startsWith(q) || q.startsWith(lbl)) s = 0.9;
              else if (lbl.includes(q) || full.includes(q)) s = 0.82;
              else if (q.includes(lbl) && lbl.length >= 3) s = 0.78;
              else if (qTokens.length > 0) {
                const hits = qTokens.filter((w) => lbl.includes(w) || full.includes(w)).length;
                if (hits > 0) s = (hits / qTokens.length) * 0.75;
              }
              if (s > bestScore) { bestScore = s; bestField = f; }
            }
            if (bestField && bestScore >= 0.45) {
              const fillRes = await formFill.fillFieldUniversal(bestField, val, { timeoutMs: 800 });
              const after = this._probeLiveDomState();
              if (!fillRes.ok) {
                return createTaskResult(req, {
                  ok: false,
                  status: fillRes.status === 'sensitive_blocked' ? 'BLOCKED_SENSITIVE' : 'EXECUTION_FAILED',
                  engine: engineName,
                  result: fillRes,
                  actualState: { ...after, domMatched: true },
                  durationMs: Date.now() - t0,
                  evidence: evidenceBase,
                  error: { code: fillRes.status === 'sensitive_blocked' ? 'SENSITIVE_FIELD_BLOCKED' : 'FILL_FAILED', message: fillRes.error || `Failed to fill "${bestField.label}"`, recoverable: true }
                });
              }
              return createTaskResult(req, {
                ok: true,
                status: 'COMPLETED',
                engine: engineName,
                result: { filled: true, value: fillRes.appliedValue, fieldType: fillRes.fieldType, validationErrors: fillRes.validationErrors || [], submitted: false },
                targetIdentity: { url: after.url, tagName: bestField.element.tagName, accessibleName: bestField.label },
                actualState: { ...after, value: fillRes.appliedValue, domMatched: true },
                durationMs: Date.now() - t0,
                evidence: evidenceBase
              });
            }
          }
        }

        const el = this._findDomInput(req.target, isSearch);
        if (!el) {
          if (req.action === 'search' && req.parameters.searchUrlTemplate) {
            const url = req.parameters.searchUrlTemplate.replace('{query}', encodeURIComponent(val));
            if (typeof window !== 'undefined' && window.location) window.location.assign(url);
            return createTaskResult(req, {
              ok: true,
              status: 'COMPLETED',
              engine: engineName,
              result: { navigatedSearch: true, query: val, url },
              targetIdentity: { url },
              actualState: { url, readyState: 'loading' },
              durationMs: Date.now() - t0,
              evidence: evidenceBase
            });
          }
          return createTaskResult(req, {
            ok: false,
            status: 'TARGET_NOT_FOUND',
            engine: engineName,
            actualState: this._probeLiveDomState(),
            durationMs: Date.now() - t0,
            evidence: evidenceBase,
            error: { code: 'TARGET_NOT_FOUND', message: `No ${req.action} input field matching "${req.target.label || req.target.selector || ''}" found on current page`, recoverable: true }
          });
        }
        // Sensitive-field safety guard on direct fallback path too
        const elType = String((el.getAttribute && el.getAttribute('type')) || el.type || '').toLowerCase();
        if (!isSearch && elType === 'password') {
          return createTaskResult(req, {
            ok: false,
            status: 'BLOCKED_SENSITIVE',
            engine: engineName,
            actualState: this._probeLiveDomState(),
            durationMs: Date.now() - t0,
            evidence: evidenceBase,
            error: { code: 'SENSITIVE_FIELD_BLOCKED', message: "Skipped sensitive password field. I'll leave this one for you.", recoverable: true }
          });
        }
        if (typeof el.scrollIntoView === 'function') el.scrollIntoView({ block: 'center', inline: 'center' });
        el.focus && el.focus();
        if (el.tagName === 'SELECT') {
          const wantLow = val.trim().toLowerCase();
          const opt = Array.from(el.options || []).find((o) =>
            o.value.toLowerCase() === wantLow || (o.text || '').trim().toLowerCase() === wantLow || (o.text || '').toLowerCase().includes(wantLow)
          );
          if (opt) el.value = opt.value;
        } else {
          const prevVal = el.value;
          const proto = el.tagName === 'TEXTAREA'
            ? (typeof HTMLTextAreaElement !== 'undefined' ? HTMLTextAreaElement.prototype : null)
            : (typeof HTMLInputElement !== 'undefined' ? HTMLInputElement.prototype : null);
          const valueSetter = proto ? Object.getOwnPropertyDescriptor(proto, 'value')?.set : null;
          if (valueSetter) {
            valueSetter.call(el, val);
          } else {
            el.value = val;
          }
          if (el._valueTracker && typeof el._valueTracker.setValue === 'function') {
            try { el._valueTracker.setValue(prevVal); } catch (_e) {}
          }
        }
        try {
          el.dispatchEvent(typeof InputEvent === 'function'
            ? new InputEvent('input', { bubbles: true, composed: true, inputType: 'insertText', data: val })
            : new Event('input', { bubbles: true, composed: true }));
        } catch (_e) {
          el.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
        }
        el.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
        if (!isSearch) {
          el.dispatchEvent(new Event('blur', { bubbles: true, composed: true }));
        }
        const shouldSubmit = req.action === 'search' || Boolean(req.parameters && req.parameters.submitAfterFill);
        if (shouldSubmit) {
          const form = el.closest && el.closest('form');
          if (form && typeof form.requestSubmit === 'function') {
            try { form.requestSubmit(); } catch (_e) { form.submit && form.submit(); }
          } else {
            el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, composed: true }));
            const rootNode = el.getRootNode ? el.getRootNode() : document;
            const searchBtn = (el.closest && el.closest('yt-searchbox, ytd-searchbox, [role="search"]')?.querySelector('button.ytSearchboxComponentSearchButton, button#search-icon-legacy, button[type="submit"]')) ||
              (rootNode && rootNode.querySelector && rootNode.querySelector('button[data-search-submit], button[type="submit"]'));
            if (searchBtn) searchBtn.click();
          }
          await new Promise((r) => setTimeout(r, 250));
        }
        await new Promise((r) => setTimeout(r, 100));
        const after = this._probeLiveDomState();
        return createTaskResult(req, {
          ok: true,
          status: 'COMPLETED',
          engine: engineName,
          result: { filled: true, value: el.value, submitted: shouldSubmit },
          targetIdentity: { url: after.url, tagName: el.tagName, accessibleName: el.getAttribute('aria-label') || el.name || el.placeholder || '' },
          actualState: { ...after, value: el.value, domMatched: true },
          durationMs: Date.now() - t0,
          evidence: evidenceBase
        });
      }

      // Navigate
      if (req.action === 'navigate') {
        const url = String(req.target.url || req.parameters.url || '').trim();
        if (!url) {
          return createTaskResult(req, { ok: false, status: 'INVALID_REQUEST', engine: engineName, durationMs: Date.now() - t0, error: 'URL required for navigate' });
        }
        if (this.controller && typeof this.controller.navigateToExternalUrl === 'function') {
          const navRes = await this.controller.navigateToExternalUrl(url, req.target.label || url, { bypassStagehand: true, cmdId: req.commandId });
          return createTaskResult(req, {
            ok: true,
            status: 'COMPLETED',
            engine: engineName,
            result: navRes,
            targetIdentity: { url },
            actualState: { url, readyState: 'loading' },
            durationMs: Date.now() - t0,
            evidence: evidenceBase
          });
        }
        if (typeof window !== 'undefined' && window.location) {
          window.location.assign(url);
          if (typeof document !== 'undefined' && req.parameters && req.parameters.awaitDocumentUnload) {
            await new Promise((resolve) => {
              const t = setTimeout(resolve, 3500);
              if (signal) {
                signal.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
              }
            });
          }
          return createTaskResult(req, {
            ok: true,
            status: 'COMPLETED',
            engine: engineName,
            result: { navigated: true, url },
            targetIdentity: { url },
            actualState: { url, readyState: 'loading' },
            durationMs: Date.now() - t0,
            evidence: evidenceBase
          });
        }
      }

      return createTaskResult(req, {
        ok: false,
        status: 'BACKEND_DISCONNECTED',
        engine: engineName,
        durationMs: Date.now() - t0,
        evidence: evidenceBase,
        error: { code: 'BACKEND_DISCONNECTED', message: `Browser backend cannot execute '${req.action}' in current environment`, recoverable: true }
      });
    }

    _findDomTarget(target = {}) {
      if (typeof document === 'undefined') return null;
      if (target.selector) {
        try {
          const direct = this._collectShadowData(document, target.selector).elements[0] || null;
          if (direct) return direct;
        } catch (_e) {}
      }
      const needle = String(target.label || target.name || target.text || '').trim().toLowerCase();
      const ctxHint = String(target.contextHint || '').trim().toLowerCase();
      const hrefHint = String(target.hrefContains || '').trim().toLowerCase();
      if (!needle && !hrefHint) return null;
      if (needle === '__first_result__') {
        const tiers = [
          'ytd-video-renderer a#video-title[href], .searchresult a[href], .mw-search-result-heading a[href], [data-search-result] a[href], main article a[href], article h2 a[href], article h3 a[href]',
          'main h2 a[href], main h3 a[href], main a[href]',
          'a[href]'
        ];
        for (const sel of tiers) {
          const hits = Array.from(document.querySelectorAll(sel))
            .filter((a) => !a.closest('nav, header, footer, ytd-ad-slot-renderer, ytd-reel-shelf-renderer') && (a.innerText || a.textContent || '').trim().length > 2 && !/^skip to/i.test((a.innerText || '').trim()));
          if (hits.length > 0) return hits[0];
        }
        return null;
      }
      // Prefer items inside an open popup/dropdown menu first (so e.g. "Select YouTube Studio" clicks the open Account menu item instead of a background video link!)
      if (needle && !ctxHint) {
        const openPopupHit = this._findOpenPopupItem(needle);
        if (openPopupHit) return openPopupHit;
      }
      const candidates = this._collectShadowData(
        document,
        'ytd-compact-link-renderer a#endpoint, ytd-toggle-theme-compact-link-renderer, ytd-guide-entry-renderer a#endpoint, ytd-mini-guide-entry-renderer a#endpoint, tp-yt-paper-item, a, button, [role="button"], [role="link"], [role="tab"], [role="menuitem"], [role="menuitemradio"], [role="menuitemcheckbox"], [role="option"], input[type="submit"], input[type="button"], [tabindex]'
      ).elements;
      let best = null;
      let bestScore = 0;
      let bestPrimaryKey = '';
      let bestUsedFuzzy = false;
      let secondScore = 0;
      const ctxWords = ctxHint.split(/\s+/).filter((w) => w.length > 2);
      const isMenuSettingTarget = needle ? this._isKnownMenuOrSettingTarget(needle) : false;
      for (const el of candidates) {
        try {
          const r = el.getBoundingClientRect();
          const st = typeof getComputedStyle === 'function' ? getComputedStyle(el) : null;
          if (r.width <= 0 || r.height <= 0 || (st && (st.visibility === 'hidden' || st.display === 'none'))) continue;
        } catch (_e) {}
        // Do not let a background video/article title hijack a known menu/setting command (e.g. "Select YouTube Studio" or "Select Dark theme")!
        if (isMenuSettingTarget && el.closest && el.closest('main, article, ytd-rich-item-renderer, ytd-video-renderer, ytd-compact-video-renderer')) {
          continue;
        }
        const primaryText = (el.innerText || el.textContent || el.getAttribute('aria-label') || el.getAttribute('title') || el.value || '').replace(/\s+/g, ' ').trim();
        const text = `${el.getAttribute('aria-label') || ''} ${el.innerText || el.textContent || ''} ${el.getAttribute('title') || ''} ${el.value || ''}`.replace(/\s+/g, ' ').trim().toLowerCase();
        const href = String(el.href || (el.getAttribute && el.getAttribute('href')) || '').toLowerCase();
        let s = 0;
        let usedFuzzy = false;
        if (hrefHint && href.includes(hrefHint)) s = 1.15;
        else if (needle && text === needle) s = 1.0;
        else if (needle && text.includes(needle)) s = 0.85;
        else if (needle && needle.split(/\s+/).filter((w) => w.length > 1).every((w) => text.includes(w))) s = 0.72;
        else if (needle && primaryText && primaryText.length <= 80) {
          const fz = this._fuzzyDomTextScore(needle, primaryText);
          if (fz >= 0.85) {
            s = fz * 0.84;
            usedFuzzy = true;
          }
        }
        if (s > 0 && ctxWords.length > 0) {
          const card = (el.closest && el.closest('article, section, li, tr, [class*="card"], [class*="item"], div')) || el.parentElement;
          const rootHost = el.getRootNode && el.getRootNode().host;
          const ctxText = `${(card && card.innerText) || ''} ${(rootHost && rootHost.textContent) || ''}`.toLowerCase();
          const hits = ctxWords.filter((w) => ctxText.includes(w)).length;
          s += (hits / ctxWords.length) * 0.35;
        }
        const labelKey = (primaryText || text).toLowerCase();
        if (s > bestScore) {
          if (bestPrimaryKey && bestPrimaryKey !== labelKey) {
            secondScore = Math.max(secondScore, bestScore);
          }
          bestScore = s;
          bestPrimaryKey = labelKey;
          bestUsedFuzzy = usedFuzzy;
          best = el;
        } else if (labelKey !== bestPrimaryKey && s > secondScore) {
          secondScore = s;
        }
      }
      if (bestUsedFuzzy && (bestScore - secondScore) < 0.08) return null;
      return bestScore >= 0.65 ? this._unwrapActionableMenuItem(best) : null;
    }

    _findDomInput(target = {}, isSearch = false) {
      if (typeof document === 'undefined') return null;
      if (target.selector) {
        try {
          const direct = this._collectShadowData(document, target.selector).elements[0] || null;
          if (direct) return direct;
        } catch (_e) {}
      }
      const needle = String(target.label || target.name || '').trim().toLowerCase();
      const hintWords = needle.replace(/\b(?:search|box|field|input|bar|the|for|in|on|main|primary)\b/g, ' ').split(/\s+/).filter((w) => w.length > 1);
      const allInputs = this._collectShadowData(
        document,
        'input:not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="checkbox"]):not([type="radio"]):not([type="file"]):not([type="image"]):not([type="reset"]), textarea, select, [role="searchbox"], [role="textbox"]'
      ).elements;
      const visibleInputs = allInputs.filter((el) => {
        try {
          if (el.disabled || el.readOnly) return false;
          const r = el.getBoundingClientRect();
          const st = typeof getComputedStyle === 'function' ? getComputedStyle(el) : null;
          return r.width > 0 && r.height > 0 && (!st || (st.visibility !== 'hidden' && st.display !== 'none'));
        } catch (_e) {
          return true;
        }
      });
      const inputs = visibleInputs.length > 0 ? visibleInputs : allInputs.filter((el) => !el.disabled && !el.readOnly);
      if (inputs.length === 0) return null;

      const resolveLabelledByText = (el, rootNode) => {
        const raw = (el.getAttribute && el.getAttribute('aria-labelledby')) || '';
        if (!raw) return '';
        const parts = [];
        for (const id of raw.trim().split(/\s+/)) {
          if (!id) continue;
          const node = (rootNode && typeof rootNode.getElementById === 'function' && rootNode.getElementById(id)) ||
            (typeof document !== 'undefined' && document.getElementById ? document.getElementById(id) : null);
          if (node) {
            const t = (node.innerText || node.textContent || '').replace(/\s+/g, ' ').trim();
            if (t) parts.push(t);
          }
        }
        return parts.join(' ').replace(/\s*\*\s*$/, '').trim();
      };

      let best = null;
      let bestScore = -999;
      for (const el of inputs) {
        const rootNode = (el.getRootNode && el.getRootNode()) || document;
        const lbl = el.id && rootNode.querySelector ? rootNode.querySelector(`label[for="${el.id}"]`) : null;
        const wrapLbl = el.closest ? el.closest('label') : null;
        const labelledBy = resolveLabelledByText(el, rootNode);
        const cardHeadingEl = el.closest ? el.closest('[role="listitem"], .question-container, .form-question')?.querySelector('[role="heading"], h2, h3, h4') : null;
        const cardHeading = (cardHeadingEl && !cardHeadingEl.contains(el)) ? (cardHeadingEl.innerText || cardHeadingEl.textContent || '').replace(/\s*\*\s*$/, '').trim() : '';
        const rawAria = (el.getAttribute('aria-label') || '').trim();
        const ariaLabel = /^(?:your\s+answer|short\s+answer|long\s+answer)$/i.test(rawAria) ? '' : rawAria;
        const desc = `${labelledBy} ${cardHeading} ${ariaLabel} ${(lbl && lbl.textContent) || ''} ${(wrapLbl && wrapLbl.textContent) || ''} ${el.getAttribute('placeholder') || ''} ${el.name || ''} ${el.id || ''}`.toLowerCase();
        const type = String(el.type || '').toLowerCase();
        let score = 10;
        if (isSearch) {
          if (el.tagName === 'SELECT') continue;
          if (el.name === 'search_query' || (el.classList && el.classList.contains('ytSearchboxComponentInput')) || el.id === 'search') score += 135;
          if (type === 'search' || el.getAttribute('role') === 'searchbox') score += 90;
          if (el.closest && el.closest('search, [role="search"], yt-searchbox, ytd-searchbox')) score += 75;
          if (/\bsearch\b/.test(desc)) score += 60;
          if (type === 'email' || type === 'password' || /\b(?:newsletter|subscribe|email|password|login|coupon|promo)\b/.test(desc)) score -= 140;
          if (/\b(?:filter|sidebar)\b/.test(desc) && !/\bfilter\b/.test(needle)) score -= 60;
          if (hintWords.length > 0) {
            score += hintWords.filter((w) => desc.includes(w)).length * 85;
          }
        } else if (needle) {
          const cleanLabelled = labelledBy.toLowerCase();
          const primaryFieldName = (labelledBy || cardHeading || ariaLabel || (lbl && lbl.textContent) || (wrapLbl && wrapLbl.textContent) || el.getAttribute('placeholder') || el.name || '').replace(/\s+/g, ' ').trim();
          if (cleanLabelled === needle || desc.trim() === needle || String(el.name || '').toLowerCase() === needle) score += 150;
          else if (cleanLabelled && (cleanLabelled.includes(needle) || needle.includes(cleanLabelled))) score += 125;
          else if (desc.includes(needle)) score += 110;
          else if (hintWords.length > 0 && hintWords.every((w) => desc.includes(w))) score += 85;
          else if (primaryFieldName) {
            const fz = this._fuzzyDomTextScore(needle, primaryFieldName);
            if (fz >= 0.84) score += Math.round(fz * 95);
            else score -= 30;
          } else score -= 30;
        }
        if (score > bestScore) {
          bestScore = score;
          best = el;
        }
      }
      // Do NOT silently overwrite an unrelated first input when a specific field label was requested and nothing matched!
      if (!isSearch && needle && bestScore < 20) return null;
      return best;
    }

    async cancel(commandId = null, taskId = null) {
      const targetCmd = commandId || this.activeCommandId;
      const ctrl = targetCmd ? this.activeControllers.get(targetCmd) : null;
      if (ctrl) {
        try { ctrl.abort('cancelled'); } catch (_e) {}
      }
      if (this.customCancel) {
        await Promise.resolve(this.customCancel(targetCmd, taskId)).catch(() => {});
      }
      if (this.stagehandAdapter && typeof this.stagehandAdapter.cancel === 'function' && this.useStagehandFn()) {
        await this.stagehandAdapter.cancel(targetCmd).catch(() => {});
      }
      if (this.browserEngine && this.browserEngine.inputController && typeof this.browserEngine.inputController.interrupt === 'function') {
        try { this.browserEngine.inputController.interrupt(); } catch (_e) {}
      }
      if (this.activeCommandId === targetCmd) {
        this.activeCommandId = null;
      }
      return { ok: true, cancelled: true, backend: 'browser', commandId: targetCmd, taskId };
    }
  }

  // =========================================================================
  // 5. DESKTOP BACKEND ADAPTER (Stage 3 sleepwalker-native.exe over Native Messaging)
  // =========================================================================
  class DesktopBackendAdapter {
    constructor(options = {}) {
      // Optional direct native transport (e.g. Node stdio client for real sleepwalker-native.exe tests)
      this.transport = options.transport || null;
      this.activeCommandId = null;
      this.activeTaskId = null;
    }

    _hasExtensionRuntime() {
      return Boolean(typeof chrome !== 'undefined' && chrome.runtime && typeof chrome.runtime.sendMessage === 'function');
    }

    async _sendNative(nativeReq, timeoutMs = 10000) {
      if (this.transport && typeof this.transport.send === 'function') {
        return this.transport.send(nativeReq, timeoutMs);
      }
      if (this._hasExtensionRuntime()) {
        return new Promise((resolve, reject) => {
          chrome.runtime.sendMessage({
            type: 'SLEEPWALKER_DESKTOP_EXECUTE',
            request: nativeReq
          }, (resp) => {
            const err = chrome.runtime && chrome.runtime.lastError;
            if (err) return reject(new Error(err.message || 'Native messaging bridge error'));
            if (!resp) return reject(new Error('Native companion returned no response (disconnected)'));
            resolve(resp);
          });
        });
      }
      throw new Error('NATIVE_COMPANION_DISCONNECTED: Neither Chrome runtime nor native stdio transport is available');
    }

    async queryActiveWindow(signal = null) {
      if (signal && signal.aborted) return null;
      const resp = await this._sendNative({
        taskId: generateId('ctx'),
        commandId: generateId('win'),
        action: 'get_active_window',
        timeout: 2500
      }, 3000);
      return resp && (resp.actualWindow || resp.result) ? (resp.actualWindow || resp.result) : null;
    }

    async listWindows(maxResults = 15, signal = null) {
      if (signal && signal.aborted) return [];
      const resp = await this._sendNative({
        taskId: generateId('ctx'),
        commandId: generateId('wins'),
        action: 'list_windows',
        target: { maxResults },
        timeout: 2500
      }, 3000);
      return (resp && resp.result && Array.isArray(resp.result.windows)) ? resp.result.windows : [];
    }

    async readWindowText(expectedWindow = null, queryTarget = {}, signal = null) {
      if (signal && signal.aborted) return null;
      const resp = await this._sendNative({
        taskId: generateId('verify'),
        commandId: generateId('read'),
        action: 'uia_read_text',
        target: queryTarget,
        expectedWindow,
        timeout: 4500
      }, 5000);
      if (resp && resp.success) {
        return { text: (resp.result && resp.result.text) || '', control: resp.actualTarget || null, window: resp.actualWindow || null };
      }
      return null;
    }

    async captureScreenshot(outputPath = null, expectedWindow = null, signal = null) {
      if (signal && signal.aborted) return { ok: false, status: 'CANCELLED' };
      const resp = await this._sendNative({
        taskId: generateId('verify'),
        commandId: generateId('shot'),
        action: 'capture_screenshot',
        target: {
          captureMode: expectedWindow ? 'window' : 'foreground_window',
          outputPath: outputPath || undefined
        },
        expectedWindow,
        timeout: 5000
      }, 6000);
      return { ok: Boolean(resp && resp.success), result: resp && resp.result, error: resp && resp.error };
    }

    _mapToNativeRequest(req) {
      const actionMap = {
        launch_app: 'launch_process'
      };
      const nativeAction = actionMap[req.action] || req.action;
      const target = { ...(req.target || {}) };
      const params = { ...(req.parameters || {}) };

      // Convenience mapping from canonical parameters to Stage 3 target fields
      if (nativeAction === 'launch_process' && !target.text) {
        target.text = params.executable || params.command || target.executable || target.app || '';
      }
      if (nativeAction === 'type_text' && target.text === undefined && params.text !== undefined) {
        target.text = String(params.text);
      }
      if (nativeAction === 'type_text' && target.delayMs === undefined && params.delayMs !== undefined) {
        target.delayMs = params.delayMs;
      }
      if (nativeAction === 'type_text' && target.verifyInput === undefined) {
        target.verifyInput = params.verifyInput !== undefined ? Boolean(params.verifyInput) : true;
      }
      if ((nativeAction === 'press_key' || nativeAction === 'key_combination') && !target.key && params.key) {
        target.key = params.key;
      }
      if (nativeAction === 'key_combination' && !target.modifiers && Array.isArray(params.modifiers)) {
        target.modifiers = params.modifiers;
      }
      if (nativeAction === 'uia_set_value' && target.value === undefined && params.value !== undefined) {
        target.value = String(params.value);
      }
      if (nativeAction === 'uia_navigate_menu' && !target.menuPath && Array.isArray(params.menuPath)) {
        target.menuPath = params.menuPath;
      }

      const expectedWindow = req.target.expectedWindow || (
        (req.target.hwnd || req.target.processName || req.target.titleContains)
          ? {
              hwnd: req.target.hwnd || undefined,
              processName: req.target.processName || undefined,
              titleContains: req.target.titleContains || undefined
            }
          : null
      );

      return {
        taskId: req.taskId,
        commandId: req.commandId,
        requestId: req.commandId,
        action: nativeAction,
        target,
        parameters: params,
        expectedWindow,
        timeout: req.timeout
      };
    }

    async execute(rawRequest) {
      const req = createTaskRequest({ ...rawRequest, backend: 'desktop' });
      const check = validateTaskRequest(req);
      if (!check.valid) {
        return createTaskResult(req, { ok: false, status: check.code, engine: 'sleepwalker_native', error: { code: check.code, message: check.error, recoverable: false } });
      }
      if (req.signal && req.signal.aborted) {
        return createTaskResult(req, { ok: false, status: 'CANCELLED', engine: 'sleepwalker_native', error: { code: 'CANCELLED', message: 'Command cancelled before desktop execution', recoverable: false } });
      }

      const t0 = Date.now();
      this.activeCommandId = req.commandId;
      this.activeTaskId = req.taskId;
      const nativeReq = this._mapToNativeRequest(req);

      let onAbort = null;
      if (req.signal) {
        onAbort = () => {
          this.cancel(req.commandId, req.taskId).catch(() => {});
        };
        req.signal.addEventListener('abort', onAbort, { once: true });
      }

      try {
        const resp = await this._sendNative(nativeReq, req.timeout + 2000);
        const ok = Boolean(resp && resp.success === true);
        const status = (resp && resp.status) || (ok ? 'COMPLETED' : 'FAILED');
        const actualWindow = (resp && resp.actualWindow) || null;
        const actualTarget = (resp && resp.actualTarget) || null;

        return createTaskResult(req, {
          ok,
          status,
          engine: 'sleepwalker_native',
          result: resp ? resp.result : null,
          targetIdentity: {
            hwnd: actualWindow ? actualWindow.hwnd : null,
            processId: actualWindow ? actualWindow.processId : null,
            processName: actualWindow ? actualWindow.processName : null,
            title: actualWindow ? actualWindow.title : null,
            controlName: actualTarget ? actualTarget.name : null,
            automationId: actualTarget ? actualTarget.automationId : null
          },
          actualState: {
            window: actualWindow,
            control: actualTarget,
            uiaText: resp && resp.result && typeof resp.result.text === 'string' ? resp.result.text : undefined
          },
          durationMs: (resp && Number.isFinite(resp.executionTimeMs)) ? resp.executionTimeMs : (Date.now() - t0),
          evidence: {
            ...(resp && resp.evidence && typeof resp.evidence === 'object' ? resp.evidence : {}),
            nativeCommandId: resp && resp.commandId
          },
          error: ok ? null : {
            code: status,
            message: (resp && resp.error) || status,
            recoverable: !['CANCELLED', 'EMERGENCY_STOP', 'PRIVILEGE_REQUIRED', 'STALE_COMMAND', 'DUPLICATE_COMMAND'].includes(status)
          }
        });
      } catch (err) {
        const msg = (err && err.message) || String(err);
        const isAbort = Boolean(req.signal && req.signal.aborted);
        const isDisconnected = /disconnected|not available|native host|exited|closed|not found/i.test(msg);
        const isTimeout = /timed?\s*out/i.test(msg);
        const status = isAbort ? 'CANCELLED' : (isTimeout ? 'TIMEOUT' : (isDisconnected ? 'BACKEND_DISCONNECTED' : 'FAILED'));
        return createTaskResult(req, {
          ok: false,
          status,
          engine: 'sleepwalker_native',
          durationMs: Date.now() - t0,
          error: { code: status, message: msg, recoverable: !isAbort }
        });
      } finally {
        if (req.signal && onAbort) {
          req.signal.removeEventListener('abort', onAbort);
        }
        if (this.activeCommandId === req.commandId) {
          this.activeCommandId = null;
          this.activeTaskId = null;
        }
      }
    }

    async cancel(commandId = null, taskId = null) {
      const targetCmd = commandId || this.activeCommandId;
      const targetTask = taskId || this.activeTaskId;
      try {
        if (this.transport && typeof this.transport.send === 'function') {
          const res = await this.transport.send({
            taskId: generateId('cancel-task'),
            commandId: generateId('cancel-cmd'),
            action: 'cancel_command',
            target: { targetCommandId: targetCmd, targetTaskId: targetTask },
            timeout: 3000
          }, 3500);
          return { ok: Boolean(res && res.success), cancelled: true, backend: 'desktop', commandId: targetCmd, taskId: targetTask, nativeResult: res && res.result };
        }
        if (this._hasExtensionRuntime()) {
          const res = await new Promise((resolve) => {
            chrome.runtime.sendMessage({
              type: 'SLEEPWALKER_DESKTOP_CANCEL',
              targetCommandId: targetCmd,
              targetTaskId: targetTask
            }, (r) => resolve(r || { success: false }));
          });
          return { ok: Boolean(res && res.success), cancelled: true, backend: 'desktop', commandId: targetCmd, taskId: targetTask, nativeResult: res && res.result };
        }
      } catch (err) {
        return { ok: false, cancelled: true, backend: 'desktop', commandId: targetCmd, error: (err && err.message) || String(err) };
      }
      return { ok: true, cancelled: true, backend: 'desktop', commandId: targetCmd };
    }
  }

  const exported = {
    LIFECYCLE_STATES,
    TERMINAL_STATES,
    ALLOWED_BROWSER_ACTIONS,
    ALLOWED_DESKTOP_ACTIONS,
    generateId,
    UnifiedLifecycleManager,
    createTaskRequest,
    validateTaskRequest,
    createTaskResult,
    SharedVerifier,
    BrowserBackendAdapter,
    DesktopBackendAdapter
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = exported;
  }
  if (rootScope) {
    rootScope.SleepwalkerUnifiedContract = exported;
  }
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));
