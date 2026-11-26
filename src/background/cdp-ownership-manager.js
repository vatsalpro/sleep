/**
 * Sleepwalker 2.0 — Deterministic CDP Single-Owner Lock Manager
 *
 * Guarantees at most ONE debugger controller (Extension chrome.debugger OR Stagehand CDP)
 * owns a Chrome tab/target at any moment.
 *
 * Architectural guarantees (Stage 2.1 Hardening):
 * 1. Serialized per-tab async FIFO mutex — no concurrent acquire/handoff/command bypass.
 * 2. Monotonic lock tokens — a stale owner can NEVER release or mutate a newer owner's lock.
 * 3. Bounded acquisition, transition, and release timeouts with AbortSignal cancellation.
 * 4. Confirmed detach/attach verification (e.g., chrome.debugger.getTargets()) — NO blind 50ms sleep.
 * 5. Tracks pending extension CDP requests and listener registration; rejects pending requests
 *    cleanly on handoff, forced detach, or tab closure, and restores listeners on reattachment.
 * 6. Full edge-case recovery: Stagehand forced disconnect, extension forced disconnect,
 *    reattachment failure (RESTORATION_FAILED), tab closure during handoff, and navigation during handoff.
 */
(function (root) {
  'use strict';

  const STATES = Object.freeze({
    IDLE: 'IDLE',
    ACQUIRING_EXTENSION: 'ACQUIRING_EXTENSION',
    OWNER_EXTENSION: 'OWNER_EXTENSION',
    TRANSITIONING_TO_STAGEHAND: 'TRANSITIONING_TO_STAGEHAND',
    OWNER_STAGEHAND: 'OWNER_STAGEHAND',
    TRANSITIONING_TO_EXTENSION: 'TRANSITIONING_TO_EXTENSION',
    RESTORATION_FAILED: 'RESTORATION_FAILED',
    CLOSED: 'CLOSED'
  });

  const OWNERS = Object.freeze({
    NONE: 'NONE',
    EXTENSION: 'EXTENSION',
    STAGEHAND: 'STAGEHAND'
  });

  function createError(code, message, details = {}) {
    const err = new Error(message);
    err.code = code;
    err.details = details;
    return err;
  }

  function withTimeoutAndAbort(promiseFactory, timeoutMs, signal, label) {
    return new Promise((resolve, reject) => {
      if (signal && signal.aborted) {
        return reject(createError('CANCELLED', `${label} cancelled before start`));
      }
      let settled = false;
      let timer = null;

      const cleanup = () => {
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
        if (signal && onAbort) {
          signal.removeEventListener('abort', onAbort);
        }
      };

      const onAbort = () => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(createError('CANCELLED', `${label} aborted during execution`));
      };

      if (signal) {
        signal.addEventListener('abort', onAbort, { once: true });
      }

      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          cleanup();
          reject(createError('TIMEOUT', `${label} timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      }

      Promise.resolve()
        .then(() => promiseFactory())
        .then((val) => {
          if (settled) return;
          settled = true;
          cleanup();
          resolve(val);
        })
        .catch((err) => {
          if (settled) return;
          settled = true;
          cleanup();
          reject(err);
        });
    });
  }

  class CDPOwnershipManager {
    /**
     * @param {Object} hooks Platform integration hooks
     * @param {(tabId: number|string) => Promise<Object>} hooks.attachExtensionDebugger
     * @param {(tabId: number|string) => Promise<Object>} hooks.detachExtensionDebugger
     * @param {(tabId: number|string) => Promise<boolean>} [hooks.verifyExtensionDetached]
     * @param {(tabId: number|string, method: string, params: Object) => Promise<any>} [hooks.sendExtensionDebuggerCommand]
     * @param {(tabId: number|string) => Promise<boolean>} [hooks.restoreExtensionListeners]
     * @param {(tabId: number|string, ctx: Object) => Promise<Object>} [hooks.connectStagehand]
     * @param {(tabId: number|string, ctx: Object) => Promise<Object>} [hooks.disconnectStagehand]
     * @param {(tabId: number|string) => Promise<boolean>} [hooks.verifyTabExists]
     * @param {Object} [options]
     */
    constructor(hooks = {}, options = {}) {
      this.hooks = hooks;
      this.options = Object.assign({
        lockAcquireTimeoutMs: 8000,
        transitionTimeoutMs: 6000,
        releaseTimeoutMs: 5000,
        detachVerifyRetries: 10,
        detachVerifyIntervalMs: 15,
        maxHistoryPerTab: 500
      }, options);

      this._records = new Map(); // tabId -> TabLockRecord
      this._tokenSeq = 0;
      this._reqSeq = 0;
    }

    _nextToken(owner, tabId) {
      this._tokenSeq += 1;
      return `cdp-lock-${this._tokenSeq}-${owner.toLowerCase()}-tab${tabId}`;
    }

    _getOrCreateRecord(tabId) {
      const key = String(tabId);
      let rec = this._records.get(key);
      if (!rec) {
        rec = {
          tabId,
          targetId: null,
          currentUrl: null,
          state: STATES.IDLE,
          owner: OWNERS.NONE,
          lockToken: null,
          commandId: null,
          previousOwner: OWNERS.NONE,
          acquiredAt: null,
          listenersActive: false,
          listenerRestoreCount: 0,
          activeTransitionAbort: null,
          expectedExtensionDetach: false,
          lastError: null,
          navigationDuringHandoffCount: 0,
          handoffCount: 0,
          pendingExtensionRequests: new Map(), // reqId -> { method, reject, createdAt }
          queue: [], // FIFO queue of serialized state-transition ops
          queueBusy: false,
          stagehandLeaseActive: false, // Exclusive lease held across connect -> execute -> release
          stagehandWaiters: [], // Bounded FIFO queue for concurrent Stagehand callers
          history: []
        };
        this._records.set(key, rec);
      }
      return rec;
    }

    _log(rec, event, details = {}) {
      const entry = {
        timestamp: new Date().toISOString(),
        tabId: rec.tabId,
        targetId: rec.targetId,
        state: rec.state,
        owner: rec.owner,
        lockToken: rec.lockToken,
        commandId: rec.commandId,
        event,
        details
      };
      rec.history.push(entry);
      if (rec.history.length > this.options.maxHistoryPerTab) {
        rec.history.shift();
      }
      return entry;
    }

    getState(tabId) {
      const rec = this._records.get(String(tabId));
      if (!rec) {
        return {
          tabId,
          targetId: null,
          state: STATES.IDLE,
          owner: OWNERS.NONE,
          lockToken: null,
          commandId: null,
          listenersActive: false,
          pendingExtensionRequests: 0,
          handoffCount: 0,
          queueDepth: 0,
          lastError: null
        };
      }
      return {
        tabId: rec.tabId,
        targetId: rec.targetId,
        currentUrl: rec.currentUrl,
        state: rec.state,
        owner: rec.owner,
        lockToken: rec.lockToken,
        commandId: rec.commandId,
        listenersActive: rec.listenersActive,
        listenerRestoreCount: rec.listenerRestoreCount,
        pendingExtensionRequests: rec.pendingExtensionRequests.size,
        handoffCount: rec.handoffCount,
        navigationDuringHandoffCount: rec.navigationDuringHandoffCount,
        queueDepth: rec.queue.length + rec.stagehandWaiters.length,
        stagehandLeaseActive: rec.stagehandLeaseActive,
        lastError: rec.lastError
      };
    }

    /**
     * Acquire exclusive Stagehand lease turn in strict FIFO order (bounded by timeoutMs & AbortSignal).
     */
    _acquireStagehandLease(rec, { timeoutMs = this.options.lockAcquireTimeoutMs, signal = null, label = 'stagehand_lease' } = {}) {
      if (rec.state === STATES.CLOSED) {
        return Promise.reject(createError('TAB_CLOSED', `Tab ${rec.tabId} is closed`));
      }
      if (signal && signal.aborted) {
        return Promise.reject(createError('CANCELLED', `${label} cancelled before lease acquire`));
      }
      if (!rec.stagehandLeaseActive) {
        rec.stagehandLeaseActive = true;
        return Promise.resolve();
      }
      return new Promise((resolve, reject) => {
        const waiter = {
          resolve,
          reject,
          signal,
          cancelled: false,
          timer: null,
          onAbort: null
        };
        const cleanup = () => {
          if (waiter.timer) { clearTimeout(waiter.timer); waiter.timer = null; }
          if (waiter.signal && waiter.onAbort) {
            waiter.signal.removeEventListener('abort', waiter.onAbort);
            waiter.onAbort = null;
          }
        };
        const abortWaiter = (err) => {
          if (waiter.cancelled) return;
          waiter.cancelled = true;
          cleanup();
          const idx = rec.stagehandWaiters.indexOf(waiter);
          if (idx !== -1) rec.stagehandWaiters.splice(idx, 1);
          reject(err);
        };
        waiter.cleanup = cleanup;
        waiter.abortWaiter = abortWaiter;

        if (timeoutMs > 0) {
          waiter.timer = setTimeout(() => {
            abortWaiter(createError('LOCK_TIMEOUT', `Timed out waiting for Stagehand lease (${label}) after ${timeoutMs}ms`));
          }, timeoutMs);
        }
        if (signal) {
          waiter.onAbort = () => abortWaiter(createError('CANCELLED', `${label} cancelled while waiting for Stagehand lease`));
          signal.addEventListener('abort', waiter.onAbort, { once: true });
        }
        rec.stagehandWaiters.push(waiter);
      });
    }

    _releaseStagehandLease(rec) {
      while (rec.stagehandWaiters.length > 0) {
        const next = rec.stagehandWaiters.shift();
        if (!next || next.cancelled) continue;
        next.cancelled = true;
        if (next.cleanup) next.cleanup();
        if (rec.state === STATES.CLOSED) {
          next.reject(createError('TAB_CLOSED', `Tab ${rec.tabId} closed while waiting for Stagehand lease`));
          continue;
        }
        // Transfer lease directly to the next FIFO waiter without dropping exclusivity
        rec.stagehandLeaseActive = true;
        next.resolve();
        return;
      }
      rec.stagehandLeaseActive = false;
    }

    getHistory(tabId) {
      const rec = this._records.get(String(tabId));
      return rec ? [...rec.history] : [];
    }

    /**
     * Serialized FIFO async mutex per tabId with bounded wait timeout and AbortSignal.
     */
    _enqueue(tabId, fn, { timeoutMs = this.options.lockAcquireTimeoutMs, signal = null, label = 'lock_op' } = {}) {
      const rec = this._getOrCreateRecord(tabId);
      if (rec.state === STATES.CLOSED) {
        return Promise.reject(createError('TAB_CLOSED', `Tab ${tabId} is closed`));
      }
      if (signal && signal.aborted) {
        return Promise.reject(createError('CANCELLED', `${label} cancelled before queueing`));
      }

      return new Promise((resolve, reject) => {
        const item = {
          fn,
          resolve,
          reject,
          signal,
          timeoutMs,
          label,
          cancelled: false,
          waitTimer: null,
          onAbort: null
        };

        const cancelWaiter = (err) => {
          if (item.cancelled) return;
          item.cancelled = true;
          if (item.waitTimer) {
            clearTimeout(item.waitTimer);
            item.waitTimer = null;
          }
          if (item.signal && item.onAbort) {
            item.signal.removeEventListener('abort', item.onAbort);
          }
          const idx = rec.queue.indexOf(item);
          if (idx !== -1) rec.queue.splice(idx, 1);
          reject(err);
        };

        if (timeoutMs > 0) {
          item.waitTimer = setTimeout(() => {
            cancelWaiter(createError('LOCK_TIMEOUT', `Timed out waiting for CDP lock (${label}) after ${timeoutMs}ms`));
          }, timeoutMs);
        }

        if (signal) {
          item.onAbort = () => cancelWaiter(createError('CANCELLED', `${label} cancelled while waiting for CDP lock`));
          signal.addEventListener('abort', item.onAbort, { once: true });
        }

        rec.queue.push(item);
        this._drainQueue(rec);
      });
    }

    async _drainQueue(rec) {
      if (rec.queueBusy) return;
      rec.queueBusy = true;
      try {
        while (rec.queue.length > 0) {
          const item = rec.queue.shift();
          if (!item || item.cancelled) continue;
          if (item.waitTimer) {
            clearTimeout(item.waitTimer);
            item.waitTimer = null;
          }
          if (item.signal && item.onAbort) {
            item.signal.removeEventListener('abort', item.onAbort);
          }
          if (rec.state === STATES.CLOSED) {
            item.reject(createError('TAB_CLOSED', `Tab ${rec.tabId} closed while queued`));
            continue;
          }
          if (item.signal && item.signal.aborted) {
            item.reject(createError('CANCELLED', `${item.label} cancelled before execution`));
            continue;
          }
          try {
            const result = await item.fn(rec);
            item.resolve(result);
          } catch (err) {
            item.reject(err);
          }
        }
      } finally {
        rec.queueBusy = false;
      }
    }

    _rejectAllPendingExtensionRequests(rec, code, reason) {
      const count = rec.pendingExtensionRequests.size;
      if (count === 0) return 0;
      for (const [reqId, pending] of rec.pendingExtensionRequests.entries()) {
        try {
          pending.reject(createError(code, `Pending CDP command ${pending.method} rejected: ${reason}`, { reqId, tabId: rec.tabId }));
        } catch (_e) {}
      }
      rec.pendingExtensionRequests.clear();
      this._log(rec, 'PENDING_REQUESTS_CLEARED', { count, code, reason });
      return count;
    }

    async _confirmExtensionDetached(rec, signal) {
      if (typeof this.hooks.verifyExtensionDetached !== 'function') {
        return true;
      }
      const maxRetries = Math.max(1, this.options.detachVerifyRetries);
      for (let attempt = 0; attempt < maxRetries; attempt++) {
        if (signal && signal.aborted) {
          throw createError('CANCELLED', 'Cancelled while confirming extension detach');
        }
        if (rec.state === STATES.CLOSED) {
          throw createError('TAB_CLOSED', 'Tab closed while confirming extension detach');
        }
        const detached = await this.hooks.verifyExtensionDetached(rec.tabId);
        if (detached) {
          return true;
        }
        if (attempt < maxRetries - 1) {
          await new Promise((r) => setTimeout(r, this.options.detachVerifyIntervalMs));
        }
      }
      throw createError('DETACH_NOT_CONFIRMED', `Extension debugger detach could not be confirmed for tab ${rec.tabId}`);
    }

    async _ensureTabOpen(rec) {
      if (rec.state === STATES.CLOSED) {
        throw createError('TAB_CLOSED', `Tab ${rec.tabId} was closed`);
      }
      if (typeof this.hooks.verifyTabExists === 'function') {
        const exists = await this.hooks.verifyTabExists(rec.tabId);
        if (!exists) {
          rec.state = STATES.CLOSED;
          rec.owner = OWNERS.NONE;
          rec.lockToken = null;
          throw createError('TAB_CLOSED', `Tab ${rec.tabId} no longer exists`);
        }
      }
    }

    /**
     * Acquire exclusive CDP ownership for the Extension (chrome.debugger).
     */
    async acquireExtension(tabId, { commandId = null, targetId = null, timeoutMs = this.options.lockAcquireTimeoutMs, signal = null } = {}) {
      return this._enqueue(tabId, async (rec) => {
        await this._ensureTabOpen(rec);

        // Already owned by extension — renew token/metadata cleanly
        if (rec.state === STATES.OWNER_EXTENSION && rec.owner === OWNERS.EXTENSION) {
          if (targetId) rec.targetId = targetId;
          rec.commandId = commandId || rec.commandId;
          this._log(rec, 'EXTENSION_OWNERSHIP_REUSED');
          return {
            ok: true,
            tabId: rec.tabId,
            targetId: rec.targetId,
            owner: rec.owner,
            state: rec.state,
            lockToken: rec.lockToken,
            alreadyOwned: true
          };
        }

        if (rec.owner === OWNERS.STAGEHAND) {
          throw createError('LOCK_HELD_BY_STAGEHAND', `Cannot attach extension while Stagehand holds lock on tab ${tabId}`, {
            activeCommandId: rec.commandId,
            state: rec.state
          });
        }

        const prevState = rec.state;
        rec.state = STATES.ACQUIRING_EXTENSION;
        rec.commandId = commandId;
        if (targetId) rec.targetId = targetId;
        this._log(rec, 'EXTENSION_ACQUIRE_START', { prevState });

        try {
          if (typeof this.hooks.attachExtensionDebugger === 'function') {
            await withTimeoutAndAbort(
              () => this.hooks.attachExtensionDebugger(rec.tabId),
              this.options.transitionTimeoutMs,
              signal,
              `attachExtensionDebugger(tab=${rec.tabId})`
            );
          }

          await this._ensureTabOpen(rec);

          if (typeof this.hooks.restoreExtensionListeners === 'function') {
            await this.hooks.restoreExtensionListeners(rec.tabId);
            rec.listenerRestoreCount += 1;
          }
          rec.listenersActive = true;

          const token = this._nextToken(OWNERS.EXTENSION, rec.tabId);
          rec.state = STATES.OWNER_EXTENSION;
          rec.owner = OWNERS.EXTENSION;
          rec.lockToken = token;
          rec.acquiredAt = Date.now();
          rec.lastError = null;
          this._log(rec, 'EXTENSION_ATTACHED', { listenersActive: rec.listenersActive });

          return {
            ok: true,
            tabId: rec.tabId,
            targetId: rec.targetId,
            owner: rec.owner,
            state: rec.state,
            lockToken: token
          };
        } catch (err) {
          if (rec.state !== STATES.CLOSED) {
            rec.state = STATES.IDLE;
            rec.owner = OWNERS.NONE;
            rec.lockToken = null;
            rec.listenersActive = false;
            rec.lastError = err.message;
          }
          this._log(rec, 'EXTENSION_ACQUIRE_FAILED', { code: err.code || 'ATTACH_ERROR', error: err.message });
          throw err;
        }
      }, { timeoutMs, signal, label: `acquireExtension(${tabId})` });
    }

    /**
     * Execute a chrome.debugger command ONLY while the Extension holds the verified lock.
     * Prevents concurrent commands from bypassing the lock and tracks pending requests.
     */
    async sendExtensionCommand(tabId, method, params = {}, { lockToken = null, timeoutMs = 10000 } = {}) {
      const rec = this._getOrCreateRecord(tabId);
      if (rec.state === STATES.CLOSED) {
        throw createError('TAB_CLOSED', `Tab ${tabId} is closed`);
      }
      if (rec.state !== STATES.OWNER_EXTENSION || rec.owner !== OWNERS.EXTENSION) {
        throw createError('LOCK_NOT_HELD', `Extension does not hold CDP lock for tab ${tabId} (state=${rec.state}, owner=${rec.owner})`);
      }
      if (lockToken && rec.lockToken !== lockToken) {
        throw createError('STALE_LOCK_TOKEN', `Stale extension lock token rejected for tab ${tabId}`, {
          provided: lockToken,
          active: rec.lockToken
        });
      }
      if (typeof this.hooks.sendExtensionDebuggerCommand !== 'function') {
        throw createError('NO_DEBUGGER_HOOK', 'sendExtensionDebuggerCommand hook is not configured');
      }

      const activeToken = rec.lockToken;
      const reqId = ++this._reqSeq;

      return new Promise((resolve, reject) => {
        let done = false;
        const finishReject = (err) => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          rec.pendingExtensionRequests.delete(reqId);
          reject(err);
        };
        const finishResolve = (val) => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          rec.pendingExtensionRequests.delete(reqId);
          resolve(val);
        };

        const timer = setTimeout(() => {
          finishReject(createError('COMMAND_TIMEOUT', `CDP command ${method} timed out after ${timeoutMs}ms`));
        }, timeoutMs);

        rec.pendingExtensionRequests.set(reqId, {
          method,
          reject: finishReject,
          createdAt: Date.now()
        });

        Promise.resolve()
          .then(() => {
            if (rec.lockToken !== activeToken || rec.state !== STATES.OWNER_EXTENSION) {
              throw createError('LOCK_LOST', `Extension lock lost before dispatching ${method}`);
            }
            return this.hooks.sendExtensionDebuggerCommand(tabId, method, params);
          })
          .then(finishResolve, finishReject);
      });
    }

    /**
     * Release Extension lock explicitly. Rejects stale tokens.
     */
    async releaseExtension(tabId, lockToken, { detach = true, timeoutMs = this.options.releaseTimeoutMs } = {}) {
      return this._enqueue(tabId, async (rec) => {
        if (rec.state === STATES.CLOSED) {
          return { ok: true, state: STATES.CLOSED, released: false };
        }
        if (rec.owner !== OWNERS.EXTENSION) {
          return { ok: false, error: 'NOT_EXTENSION_OWNER', state: rec.state, owner: rec.owner };
        }
        if (lockToken && rec.lockToken !== lockToken) {
          this._log(rec, 'STALE_RELEASE_REJECTED', { attemptedToken: lockToken, activeToken: rec.lockToken, caller: 'EXTENSION' });
          return { ok: false, error: 'STALE_LOCK_TOKEN', state: rec.state, activeToken: rec.lockToken };
        }

        this._rejectAllPendingExtensionRequests(rec, 'EXTENSION_RELEASED', 'Extension lock explicitly released');
        if (detach && typeof this.hooks.detachExtensionDebugger === 'function') {
          rec.expectedExtensionDetach = true;
          try {
            await withTimeoutAndAbort(
              () => this.hooks.detachExtensionDebugger(rec.tabId),
              timeoutMs,
              null,
              `detachExtensionDebugger(tab=${rec.tabId})`
            );
            await this._confirmExtensionDetached(rec, null);
          } finally {
            rec.expectedExtensionDetach = false;
          }
        }

        rec.state = STATES.IDLE;
        rec.owner = OWNERS.NONE;
        rec.lockToken = null;
        rec.commandId = null;
        rec.listenersActive = false;
        this._log(rec, 'EXTENSION_RELEASED');
        return { ok: true, state: rec.state, released: true };
      }, { timeoutMs, label: `releaseExtension(${tabId})` });
    }

    /**
     * Serialized handoff from IDLE or OWNER_EXTENSION -> OWNER_STAGEHAND.
     * Enforces confirmed extension detach BEFORE Stagehand connects.
     * Supports AbortSignal cancellation mid-transition with safe rollback!
     */
    async handoffToStagehand(tabId, {
      commandId = `cmd-${Date.now()}`,
      targetId = null,
      url = null,
      bridgeUrl = null,
      cdpUrl = null,
      timeoutMs = this.options.lockAcquireTimeoutMs,
      signal = null
    } = {}) {
      const leaseRec = this._getOrCreateRecord(tabId);
      await this._acquireStagehandLease(leaseRec, {
        timeoutMs,
        signal,
        label: `handoffToStagehand(${tabId}, ${commandId})`
      });

      try {
        return await this._enqueue(tabId, async (rec) => {
          await this._ensureTabOpen(rec);

          if (rec.owner === OWNERS.STAGEHAND && rec.state === STATES.OWNER_STAGEHAND) {
            throw createError('ALREADY_OWNED_BY_STAGEHAND', `Stagehand already owns tab ${tabId} (cmd=${rec.commandId})`);
          }
          if (rec.state === STATES.TRANSITIONING_TO_STAGEHAND || rec.state === STATES.TRANSITIONING_TO_EXTENSION) {
            throw createError('TRANSITION_IN_PROGRESS', `Tab ${tabId} is already transitioning (${rec.state})`);
          }

        const priorOwner = rec.owner;
        const hadExtension = priorOwner === OWNERS.EXTENSION;
        const transitionController = new AbortController();
        rec.activeTransitionAbort = transitionController;

        const onExternalAbort = () => transitionController.abort('caller_cancelled');
        if (signal) {
          if (signal.aborted) {
            rec.activeTransitionAbort = null;
            throw createError('CANCELLED', `Handoff for ${commandId} cancelled before start`);
          }
          signal.addEventListener('abort', onExternalAbort, { once: true });
        }

        rec.previousOwner = priorOwner;
        rec.state = STATES.TRANSITIONING_TO_STAGEHAND;
        rec.commandId = commandId;
        if (targetId) rec.targetId = targetId;
        if (url) rec.currentUrl = url;
        this._log(rec, 'HANDOFF_TO_STAGEHAND_START', { priorOwner, hadExtension });

        let extensionDetached = !hadExtension;
        let stagehandConnected = false;

        try {
          // Step 1: Reject pending extension commands & detach chrome.debugger cleanly
          if (hadExtension) {
            this._rejectAllPendingExtensionRequests(rec, 'DEBUGGER_HANDOFF_DETACH', `Handing off tab ${tabId} to Stagehand for ${commandId}`);
            rec.expectedExtensionDetach = true;
            try {
              if (typeof this.hooks.detachExtensionDebugger === 'function') {
                await withTimeoutAndAbort(
                  () => this.hooks.detachExtensionDebugger(rec.tabId),
                  this.options.transitionTimeoutMs,
                  transitionController.signal,
                  `detachExtensionDebugger(tab=${rec.tabId})`
                );
              }
              await this._confirmExtensionDetached(rec, transitionController.signal);
              extensionDetached = true;
              rec.listenersActive = false;
              rec.lockToken = null; // Invalidate prior extension lock token immediately
              this._log(rec, 'EXTENSION_DETACH_CONFIRMED');
            } finally {
              rec.expectedExtensionDetach = false;
            }
          }

          // Check cancellation / tab survival between detach and Stagehand connect
          await this._ensureTabOpen(rec);
          if (transitionController.signal.aborted) {
            throw createError('CANCELLED', `Handoff to Stagehand cancelled after extension detach (${commandId})`);
          }

          // Step 2: Connect Stagehand
          let connectInfo = {};
          if (typeof this.hooks.connectStagehand === 'function') {
            connectInfo = await withTimeoutAndAbort(
              () => this.hooks.connectStagehand(rec.tabId, {
                commandId,
                targetId: rec.targetId,
                url: rec.currentUrl,
                bridgeUrl,
                cdpUrl,
                signal: transitionController.signal
              }),
              this.options.transitionTimeoutMs,
              transitionController.signal,
              `connectStagehand(tab=${rec.tabId})`
            ) || {};
            stagehandConnected = true;
          }

          // Final cancellation / tab survival check right after Stagehand connect
          await this._ensureTabOpen(rec);
          if (transitionController.signal.aborted) {
            throw createError('CANCELLED', `Handoff to Stagehand cancelled right after connect (${commandId})`);
          }

          if (connectInfo.targetId) rec.targetId = connectInfo.targetId;
          if (connectInfo.url) rec.currentUrl = connectInfo.url;

          const token = this._nextToken(OWNERS.STAGEHAND, rec.tabId);
          rec.state = STATES.OWNER_STAGEHAND;
          rec.owner = OWNERS.STAGEHAND;
          rec.lockToken = token;
          rec.acquiredAt = Date.now();
          rec.lastError = null;
          rec.handoffCount += 1;
          this._log(rec, 'STAGEHAND_OWNERSHIP_ACQUIRED', { connectInfo });

          return {
            ok: true,
            tabId: rec.tabId,
            targetId: rec.targetId,
            owner: rec.owner,
            state: rec.state,
            lockToken: token,
            commandId,
            priorOwner,
            connectInfo
          };
        } catch (err) {
          this._log(rec, 'HANDOFF_TO_STAGEHAND_ABORTED', {
            code: err.code || 'HANDOFF_FAILED',
            error: err.message,
            extensionDetached,
            stagehandConnected
          });

          // Rollback Step A: If Stagehand connected before failure/cancel, disconnect it first!
          if (stagehandConnected && typeof this.hooks.disconnectStagehand === 'function') {
            try {
              await withTimeoutAndAbort(
                () => this.hooks.disconnectStagehand(rec.tabId, { commandId, reason: err.code || 'rollback' }),
                this.options.releaseTimeoutMs,
                null,
                `rollbackDisconnectStagehand(tab=${rec.tabId})`
              );
              this._log(rec, 'ROLLBACK_STAGEHAND_DISCONNECTED');
            } catch (discErr) {
              this._log(rec, 'ROLLBACK_STAGEHAND_DISCONNECT_ERROR', { error: discErr.message });
            }
          }

          // Rollback Step B: If tab is still open and Extension owned it previously, restore Extension!
          if (rec.state !== STATES.CLOSED && hadExtension && extensionDetached) {
            await this._attemptExtensionRestoration(rec, 'rollback_after_failed_handoff');
          } else if (rec.state !== STATES.CLOSED) {
            rec.state = STATES.IDLE;
            rec.owner = OWNERS.NONE;
            rec.lockToken = null;
            rec.commandId = null;
            rec.lastError = err.message;
          }

          throw err;
        } finally {
          rec.activeTransitionAbort = null;
          if (signal) {
            signal.removeEventListener('abort', onExternalAbort);
          }
        }
      }, { timeoutMs, signal, label: `handoffToStagehand(${tabId}, ${commandId})` });
      } catch (err) {
        this._releaseStagehandLease(leaseRec);
        throw err;
      }
    }

    async _attemptExtensionRestoration(rec, reason) {
      if (rec.state === STATES.CLOSED) {
        return { restored: false, state: STATES.CLOSED, error: 'TAB_CLOSED' };
      }
      try {
        await this._ensureTabOpen(rec);
        if (typeof this.hooks.attachExtensionDebugger === 'function') {
          await withTimeoutAndAbort(
            () => this.hooks.attachExtensionDebugger(rec.tabId),
            this.options.transitionTimeoutMs,
            null,
            `restoreExtensionDebugger(tab=${rec.tabId})`
          );
        }
        if (typeof this.hooks.restoreExtensionListeners === 'function') {
          await this.hooks.restoreExtensionListeners(rec.tabId);
          rec.listenerRestoreCount += 1;
        }
        rec.listenersActive = true;
        const restoredToken = this._nextToken(OWNERS.EXTENSION, rec.tabId);
        rec.state = STATES.OWNER_EXTENSION;
        rec.owner = OWNERS.EXTENSION;
        rec.lockToken = restoredToken;
        rec.commandId = null;
        rec.acquiredAt = Date.now();
        rec.lastError = null;
        this._log(rec, 'EXTENSION_RESTORED', { reason, listenersActive: true, listenerRestoreCount: rec.listenerRestoreCount });
        return { restored: true, state: rec.state, lockToken: restoredToken };
      } catch (restoreErr) {
        if (rec.state !== STATES.CLOSED) {
          rec.state = STATES.RESTORATION_FAILED;
          rec.owner = OWNERS.NONE;
          rec.lockToken = null;
          rec.commandId = null;
          rec.listenersActive = false;
          rec.lastError = restoreErr.message;
        }
        this._log(rec, 'RESTORATION_FAILED', { reason, error: restoreErr.message, recoverable: true });
        return { restored: false, state: rec.state, error: restoreErr.message, recoverable: true };
      }
    }

    /**
     * Release Stagehand lock and optionally restore Extension debugger ownership.
     * Strictly validates lockToken so a stale Stagehand command can NEVER release a newer owner's lock!
     */
    async releaseStagehand(tabId, lockToken, {
      restorePreviousOwner = true,
      bridgeUrl = null,
      timeoutMs = this.options.releaseTimeoutMs,
      reason = 'command_complete'
    } = {}) {
      return this._enqueue(tabId, async (rec) => {
        if (rec.state === STATES.CLOSED) {
          return { ok: true, state: STATES.CLOSED, released: false, reason: 'tab_closed' };
        }

        // Strict stale-owner token check!
        if (!lockToken || rec.lockToken !== lockToken || rec.owner !== OWNERS.STAGEHAND) {
          this._log(rec, 'STALE_RELEASE_REJECTED', {
            attemptedToken: lockToken,
            activeToken: rec.lockToken,
            activeOwner: rec.owner,
            activeState: rec.state,
            caller: 'STAGEHAND'
          });
          return {
            ok: false,
            error: 'STALE_LOCK_TOKEN',
            released: false,
            state: rec.state,
            owner: rec.owner,
            activeToken: rec.lockToken
          };
        }

        const shouldRestoreExtension = Boolean(restorePreviousOwner && rec.previousOwner === OWNERS.EXTENSION);
        const releasedCmdId = rec.commandId;
        rec.state = STATES.TRANSITIONING_TO_EXTENSION;
        this._log(rec, 'RELEASE_STAGEHAND_START', { reason, shouldRestoreExtension });

        let disconnectErr = null;
        if (typeof this.hooks.disconnectStagehand === 'function') {
          try {
            await withTimeoutAndAbort(
              () => this.hooks.disconnectStagehand(rec.tabId, { commandId: releasedCmdId, reason, bridgeUrl }),
              timeoutMs,
              null,
              `disconnectStagehand(tab=${rec.tabId})`
            );
            this._log(rec, 'STAGEHAND_DISCONNECTED');
          } catch (err) {
            disconnectErr = err;
            this._log(rec, 'STAGEHAND_DISCONNECT_ERROR', { error: err.message });
          }
        }

        // Invalidate Stagehand token immediately after disconnect attempt
        rec.lockToken = null;
        rec.owner = OWNERS.NONE;

        if (rec.state === STATES.CLOSED) {
          this._releaseStagehandLease(rec);
          return { ok: true, state: STATES.CLOSED, released: true };
        }

        if (shouldRestoreExtension) {
          const restoreRes = await this._attemptExtensionRestoration(rec, reason);
          this._releaseStagehandLease(rec);
          if (!restoreRes.restored) {
            return {
              ok: false,
              released: true,
              restored: false,
              recoverable: true,
              error: restoreRes.error || 'EXTENSION_RESTORATION_FAILED',
              disconnectError: disconnectErr ? disconnectErr.message : null,
              state: rec.state,
              owner: rec.owner
            };
          }
          return {
            ok: true,
            released: true,
            restored: true,
            state: rec.state,
            owner: rec.owner,
            restoredLockToken: restoreRes.lockToken,
            disconnectError: disconnectErr ? disconnectErr.message : null
          };
        }

        rec.state = STATES.IDLE;
        rec.owner = OWNERS.NONE;
        rec.commandId = null;
        rec.previousOwner = OWNERS.NONE;
        rec.lastError = disconnectErr ? disconnectErr.message : null;
        this._log(rec, 'STAGEHAND_RELEASED_TO_IDLE');
        this._releaseStagehandLease(rec);

        return {
          ok: true,
          released: true,
          restored: false,
          state: rec.state,
          owner: rec.owner,
          disconnectError: disconnectErr ? disconnectErr.message : null
        };
      }, { timeoutMs, label: `releaseStagehand(${tabId})` });
    }

    /**
     * Handle unexpected Stagehand client/sidecar disconnection (crash, WS drop).
     */
    async onStagehandDisconnected(tabId, { reason = 'unexpected_disconnect', restorePreviousOwner = true } = {}) {
      const rec = this._records.get(String(tabId));
      if (!rec || rec.state === STATES.CLOSED) {
        return { ok: true, handled: false, state: rec ? rec.state : STATES.IDLE };
      }

      // Abort any active transition to Stagehand
      if (rec.state === STATES.TRANSITIONING_TO_STAGEHAND && rec.activeTransitionAbort) {
        rec.activeTransitionAbort.abort(`stagehand_disconnected:${reason}`);
        this._log(rec, 'STAGEHAND_DISCONNECT_ABORTED_TRANSITION', { reason });
        return { ok: true, handled: true, abortedTransition: true, state: rec.state };
      }

      if (rec.owner !== OWNERS.STAGEHAND) {
        return { ok: true, handled: false, state: rec.state, owner: rec.owner };
      }

      const staleToken = rec.lockToken;
      this._log(rec, 'STAGEHAND_FORCED_DISCONNECT', { reason, invalidatedToken: staleToken });
      return this.releaseStagehand(tabId, staleToken, { restorePreviousOwner, reason: `forced_disconnect:${reason}` });
    }

    /**
     * Handle chrome.debugger.onDetach event (user cancelled infobar, DevTools opened, target crashed).
     */
    onExtensionDetached(tabId, reason = 'unknown') {
      const rec = this._records.get(String(tabId));
      if (!rec) return { handled: false };

      this._rejectAllPendingExtensionRequests(rec, 'EXTENSION_DETACHED', `chrome.debugger.onDetach: ${reason}`);
      rec.listenersActive = false;

      if (rec.expectedExtensionDetach) {
        this._log(rec, 'EXTENSION_EXPECTED_DETACH_EVENT', { reason });
        return { handled: true, expected: true, state: rec.state };
      }

      if (rec.state === STATES.OWNER_EXTENSION || rec.state === STATES.ACQUIRING_EXTENSION) {
        rec.state = STATES.IDLE;
        rec.owner = OWNERS.NONE;
        rec.lockToken = null;
        rec.commandId = null;
        rec.lastError = `extension_detached:${reason}`;
        this._log(rec, 'EXTENSION_FORCED_DETACH', { reason });
        return { handled: true, expected: false, state: rec.state };
      }

      this._log(rec, 'EXTENSION_DETACH_OBSERVED_OTHER_STATE', { reason });
      return { handled: true, expected: false, state: rec.state };
    }

    /**
     * Handle chrome.tabs.onRemoved — tab closed (possibly mid-handoff!).
     */
    onTabClosed(tabId) {
      const rec = this._records.get(String(tabId));
      if (!rec) return { handled: false };

      const prevState = rec.state;
      const prevOwner = rec.owner;
      rec.state = STATES.CLOSED;
      rec.owner = OWNERS.NONE;
      rec.lockToken = null;
      rec.listenersActive = false;

      if (rec.activeTransitionAbort) {
        try { rec.activeTransitionAbort.abort('tab_closed'); } catch (_e) {}
      }

      const clearedReqs = this._rejectAllPendingExtensionRequests(rec, 'TAB_CLOSED', `Tab ${tabId} was closed`);

      // Reject all queued waiters immediately
      let clearedWaiters = 0;
      rec.stagehandLeaseActive = false;
      while (rec.stagehandWaiters.length > 0) {
        const sw = rec.stagehandWaiters.shift();
        if (sw && !sw.cancelled) {
          sw.cancelled = true;
          if (sw.cleanup) sw.cleanup();
          sw.reject(createError('TAB_CLOSED', `Tab ${tabId} closed while waiting for Stagehand lease`));
          clearedWaiters += 1;
        }
      }
      while (rec.queue.length > 0) {
        const waiter = rec.queue.shift();
        if (waiter && !waiter.cancelled) {
          waiter.cancelled = true;
          if (waiter.waitTimer) clearTimeout(waiter.waitTimer);
          if (waiter.signal && waiter.onAbort) waiter.signal.removeEventListener('abort', waiter.onAbort);
          waiter.reject(createError('TAB_CLOSED', `Tab ${tabId} closed while queued`));
          clearedWaiters += 1;
        }
      }

      if (prevOwner === OWNERS.STAGEHAND && typeof this.hooks.disconnectStagehand === 'function') {
        Promise.resolve(this.hooks.disconnectStagehand(tabId, { reason: 'tab_closed' })).catch(() => {});
      }

      this._log(rec, 'TAB_CLOSED', { prevState, prevOwner, clearedReqs, clearedWaiters });
      return { handled: true, prevState, prevOwner, clearedReqs, clearedWaiters, state: STATES.CLOSED };
    }

    /**
     * Handle page navigation during ownership or mid-handoff.
     */
    onTabNavigated(tabId, newUrl) {
      const rec = this._records.get(String(tabId));
      if (!rec || rec.state === STATES.CLOSED) return { handled: false };

      const prevUrl = rec.currentUrl;
      rec.currentUrl = newUrl;
      const duringHandoff = rec.state === STATES.TRANSITIONING_TO_STAGEHAND || rec.state === STATES.TRANSITIONING_TO_EXTENSION;
      if (duringHandoff) {
        rec.navigationDuringHandoffCount += 1;
      }
      this._log(rec, 'TAB_NAVIGATED', { prevUrl, newUrl, duringHandoff });
      return { handled: true, duringHandoff, state: rec.state, newUrl };
    }

    /**
     * Explicit recovery from RESTORATION_FAILED or stuck error state.
     */
    async recover(tabId, { targetOwner = OWNERS.EXTENSION } = {}) {
      return this._enqueue(tabId, async (rec) => {
        await this._ensureTabOpen(rec);
        this._log(rec, 'RECOVERY_REQUESTED', { fromState: rec.state, targetOwner });

        // Ensure Stagehand is disconnected first
        if (typeof this.hooks.disconnectStagehand === 'function') {
          try { await this.hooks.disconnectStagehand(rec.tabId, { reason: 'explicit_recovery' }); } catch (_e) {}
        }

        if (targetOwner === OWNERS.EXTENSION) {
          const res = await this._attemptExtensionRestoration(rec, 'explicit_recovery');
          return { ok: res.restored, ...res };
        }

        rec.state = STATES.IDLE;
        rec.owner = OWNERS.NONE;
        rec.lockToken = null;
        rec.commandId = null;
        rec.lastError = null;
        this._log(rec, 'RECOVERED_TO_IDLE');
        return { ok: true, state: STATES.IDLE };
      }, { label: `recover(${tabId})` });
    }
  }

  const exported = {
    CDPOwnershipManager,
    STATES,
    OWNERS
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = exported;
  }
  if (root) {
    root.SleepwalkerCDPOwnershipManager = CDPOwnershipManager;
    root.CDP_OWNERSHIP_STATES = STATES;
    root.CDP_OWNERSHIP_OWNERS = OWNERS;
  }
})(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : this));
