/**
 * Sleepwalker 2.0 — Hardened Stagehand Browser Adapter (Stage 2.1)
 *
 * Manifest V3 architecture:
 *   Content Script (Sleepwalker orchestrator + StagehandBrowserAdapter)
 *     -> chrome.runtime.sendMessage(...)
 *   MV3 Service Worker (background.js + CDPOwnershipManager)
 *     -> confirmed chrome.debugger detach -> loopback HTTP (127.0.0.1:4892)
 *   Local Node.js Sidecar (stagehand-bridge/server.mjs hosting @browserbasehq/stagehand@3.7.4)
 *     -> direct CDP to Chrome target + LocalOllamaLLMClient (127.0.0.1:11434)
 *
 * Guarantees:
 * - Feature-flagged: window.__SLEEPWALKER_ENABLE_STAGEHAND_ADAPTER__ (default: false).
 * - Atomic execution only (connect, observe, act, extract, verify, cancel, disconnect).
 * - Stagehand's autonomous agent() loop is disabled; all planning stays in Sleepwalker.
 * - Never fakes Stagehand execution with silent DOM fallbacks inside the adapter:
 *   if the Stagehand sidecar is disconnected, reports a truthful recoverable error.
 */
(function (global) {
  'use strict';

  function isFeatureEnabled() {
    if (typeof window !== 'undefined' && typeof window.__SLEEPWALKER_ENABLE_STAGEHAND_ADAPTER__ !== 'undefined') {
      return Boolean(window.__SLEEPWALKER_ENABLE_STAGEHAND_ADAPTER__);
    }
    if (typeof globalThis !== 'undefined' && typeof globalThis.__SLEEPWALKER_ENABLE_STAGEHAND_ADAPTER__ !== 'undefined') {
      return Boolean(globalThis.__SLEEPWALKER_ENABLE_STAGEHAND_ADAPTER__);
    }
    return false;
  }

  function setFeatureEnabled(enabled) {
    if (typeof window !== 'undefined') {
      window.__SLEEPWALKER_ENABLE_STAGEHAND_ADAPTER__ = Boolean(enabled);
    }
    if (typeof globalThis !== 'undefined') {
      globalThis.__SLEEPWALKER_ENABLE_STAGEHAND_ADAPTER__ = Boolean(enabled);
    }
  }

  function isLoopbackUrl(rawUrl) {
    try {
      const u = new URL(String(rawUrl || '').trim());
      if (u.protocol !== 'http:') return false;
      const h = u.hostname.toLowerCase();
      return h === '127.0.0.1' || h === 'localhost' || h === '[::1]' || h === '::1';
    } catch (_e) {
      return false;
    }
  }

  function sendRuntimeMessage(message) {
    return new Promise((resolve, reject) => {
      if (typeof chrome === 'undefined' || !chrome.runtime || typeof chrome.runtime.sendMessage !== 'function') {
        return reject(new Error('CHROME_RUNTIME_UNAVAILABLE'));
      }
      chrome.runtime.sendMessage(message, (response) => {
        const lastErr = chrome.runtime && chrome.runtime.lastError;
        if (lastErr) {
          return reject(new Error(lastErr.message || 'chrome.runtime.sendMessage failed'));
        }
        resolve(response);
      });
    });
  }

  class StagehandBrowserAdapter {
    constructor(options = {}) {
      this.options = Object.assign({
        bridgeUrl: 'http://127.0.0.1:4892',
        cdpEndpoint: 'http://127.0.0.1:9222',
        ollamaEndpoint: 'http://127.0.0.1:11434',
        actionTimeoutMs: 18000,
        models: {
          router: 'qwen2.5:1.5b',
          planner: 'llama3.2:3b',
          vision: 'qwen3-vl:2b',
          memory: 'nomic-embed-text:latest'
        }
      }, options);

      if (!isLoopbackUrl(this.options.bridgeUrl)) {
        throw new Error('StagehandBrowserAdapter only permits loopback bridge URLs (127.0.0.1 / localhost)');
      }

      this.state = 'IDLE'; // IDLE | CONNECTED | BUSY | ERROR
      this.activeCommandId = null;
      this.activeTabId = null;
      this.lastStagehandVersion = null;
      this.telemetryLogs = [];
    }

    static isEnabled() {
      return isFeatureEnabled();
    }

    static enable() {
      setFeatureEnabled(true);
    }

    static disable() {
      setFeatureEnabled(false);
    }

    _log(type, details = {}) {
      const entry = {
        timestamp: new Date().toISOString(),
        adapter: 'StagehandBrowserAdapter',
        state: this.state,
        commandId: this.activeCommandId,
        stagehandVersion: this.lastStagehandVersion,
        type,
        ...details
      };
      this.telemetryLogs.push(entry);
      if (this.telemetryLogs.length > 200) this.telemetryLogs.shift();
      return entry;
    }

    getTelemetry() {
      return [...this.telemetryLogs];
    }

    clearTelemetry() {
      this.telemetryLogs = [];
    }

    _hasExtensionRuntime() {
      return Boolean(typeof chrome !== 'undefined' && chrome.runtime && typeof chrome.runtime.sendMessage === 'function');
    }

    async _directBridgeFetch(path, method = 'POST', body = null, { timeoutMs = 15000, signal = null } = {}) {
      const base = this.options.bridgeUrl.replace(/\/+$/, '');
      if (!isLoopbackUrl(base)) {
        throw new Error('Rejected non-loopback Stagehand bridge URL');
      }
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(new Error(`Stagehand bridge ${path} timed out`)), timeoutMs);
      const onAbort = () => ctrl.abort(signal.reason || 'cancelled');
      if (signal) {
        if (signal.aborted) {
          clearTimeout(timer);
          throw new Error('CANCELLED');
        }
        signal.addEventListener('abort', onAbort, { once: true });
      }
      try {
        const res = await fetch(`${base}${path}`, {
          method,
          headers: { 'Content-Type': 'application/json' },
          body: method !== 'GET' && body !== null ? JSON.stringify(body) : undefined,
          signal: ctrl.signal
        });
        const data = await res.json().catch(() => ({ ok: false, error: `HTTP ${res.status}` }));
        if (!res.ok || data.ok === false) {
          throw new Error(data.error || `Stagehand bridge HTTP ${res.status}`);
        }
        return data;
      } finally {
        clearTimeout(timer);
        if (signal) signal.removeEventListener('abort', onAbort);
      }
    }

    async _executeViaBackground(operation, params = {}, options = {}) {
      const commandId = options.commandId || `sh-${operation}-${Date.now().toString(36)}`;
      const timeoutMs = Number(options.timeoutMs || this.options.actionTimeoutMs);
      const signal = options.signal || null;

      if (signal && signal.aborted) {
        return { ok: false, cancelled: true, error: 'CANCELLED', commandId };
      }

      this.activeCommandId = commandId;
      this.state = 'BUSY';
      const t0 = Date.now();
      this._log(`${operation.toUpperCase()}_START`, { commandId, params });

      let onAbort = null;
      if (signal) {
        onAbort = () => {
          this.cancel(commandId).catch(() => {});
        };
        signal.addEventListener('abort', onAbort, { once: true });
      }

      try {
        let resp;
        if (this._hasExtensionRuntime()) {
          resp = await sendRuntimeMessage({
            type: 'SLEEPWALKER_STAGEHAND_EXECUTE',
            tabId: options.tabId || this.activeTabId || undefined,
            url: options.url || (typeof window !== 'undefined' && window.location ? window.location.href : null),
            payload: {
              operation,
              params,
              commandId,
              timeoutMs,
              bridgeUrl: options.bridgeUrl || this.options.bridgeUrl,
              cdpUrl: options.cdpUrl || this.options.cdpEndpoint,
              verifyAfter: options.verifyAfter || null,
              restorePreviousOwner: options.restorePreviousOwner !== false
            }
          });
        } else {
          // Direct Node/test bridge mode (no Chrome extension runtime)
          const pathMap = { connect: '/connect', observe: '/observe', act: '/act', extract: '/extract', verify: '/verify', disconnect: '/disconnect' };
          const raw = await this._directBridgeFetch(pathMap[operation], 'POST', {
            ...params,
            cdpUrl: options.cdpUrl || this.options.cdpEndpoint,
            commandId,
            timeoutMs
          }, { timeoutMs, signal });
          resp = { ok: true, operation, commandId, stagehandVersion: raw.stagehandVersion, result: raw };
        }

        if (!resp || resp.ok === false) {
          const errMsg = (resp && resp.error) || 'STAGEHAND_OPERATION_FAILED';
          const errCode = (resp && resp.code) || 'STAGEHAND_ERROR';
          this.state = 'ERROR';
          this._log(`${operation.toUpperCase()}_ERROR`, { commandId, code: errCode, error: errMsg, durationMs: Date.now() - t0 });
          return {
            ok: false,
            error: errMsg,
            code: errCode,
            recoverable: true,
            commandId,
            ownership: resp ? resp.ownership : null,
            durationMs: Date.now() - t0
          };
        }

        if (resp.stagehandVersion) this.lastStagehandVersion = resp.stagehandVersion;
        if (resp.result && resp.result.stagehandVersion) this.lastStagehandVersion = resp.result.stagehandVersion;

        this.state = operation === 'disconnect' ? 'IDLE' : 'CONNECTED';
        const durationMs = Date.now() - t0;
        this._log(`${operation.toUpperCase()}_COMPLETE`, {
          commandId,
          durationMs,
          stagehandVersion: this.lastStagehandVersion
        });

        return {
          ...resp,
          ok: true,
          commandId,
          durationMs
        };
      } catch (err) {
        const msg = (err && err.message) || String(err);
        this.state = 'ERROR';
        this._log(`${operation.toUpperCase()}_EXCEPTION`, { commandId, error: msg, durationMs: Date.now() - t0 });
        return {
          ok: false,
          error: msg,
          code: signal && signal.aborted ? 'CANCELLED' : 'STAGEHAND_UNAVAILABLE',
          recoverable: true,
          commandId,
          durationMs: Date.now() - t0
        };
      } finally {
        if (signal && onAbort) {
          signal.removeEventListener('abort', onAbort);
        }
        if (this.activeCommandId === commandId) {
          this.activeCommandId = null;
        }
      }
    }

    async health() {
      try {
        if (this._hasExtensionRuntime()) {
          const res = await sendRuntimeMessage({
            type: 'SLEEPWALKER_STAGEHAND_HEALTH',
            bridgeUrl: this.options.bridgeUrl
          });
          if (res && res.stagehandVersion) this.lastStagehandVersion = res.stagehandVersion;
          return res || { ok: false, available: false, error: 'NO_RESPONSE' };
        }
        const raw = await this._directBridgeFetch('/health', 'GET', null, { timeoutMs: 2500 });
        if (raw && raw.stagehandVersion) this.lastStagehandVersion = raw.stagehandVersion;
        return { ok: true, available: true, ...raw };
      } catch (err) {
        return { ok: false, available: false, error: (err && err.message) || String(err) };
      }
    }

    async getOwnershipState(tabId = null) {
      if (!this._hasExtensionRuntime()) return null;
      return sendRuntimeMessage({
        type: 'SLEEPWALKER_CDP_OWNERSHIP_STATE',
        tabId: tabId || this.activeTabId || undefined
      }).catch(() => null);
    }

    async connect(tabId = null, options = {}) {
      if (tabId) this.activeTabId = tabId;
      return this._executeViaBackground('connect', {
        targetId: options.targetId || null,
        url: options.url || (typeof window !== 'undefined' && window.location ? window.location.href : null)
      }, { ...options, tabId: tabId || this.activeTabId });
    }

    async observe(query = '', options = {}) {
      return this._executeViaBackground('observe', {
        query: String(query || ''),
        useLlm: Boolean(options.useLlm),
        includeShadowDom: options.includeShadowDom !== false
      }, options);
    }

    async act(actionType, target = null, value = null, options = {}) {
      return this._executeViaBackground('act', {
        actionType: String(actionType || ''),
        target,
        value,
        contextHint: options.contextHint || null,
        submitAfterFill: Boolean(options.submitAfterFill),
        actionObj: options.actionObj || null
      }, options);
    }

    async extract(schema = null, query = '', options = {}) {
      return this._executeViaBackground('extract', {
        schema,
        query: String(query || ''),
        extractMode: options.extractMode || (schema && schema.mode) || null,
        maxResults: Number(options.maxResults || (schema && schema.maxResults) || 5),
        useLlm: Boolean(options.useLlm)
      }, options);
    }

    async verify(expectedState = {}, options = {}) {
      return this._executeViaBackground('verify', {
        expectedState
      }, options);
    }

    async disconnect(options = {}) {
      const res = await this._executeViaBackground('disconnect', {
        reason: options.reason || 'adapter_disconnect'
      }, options);
      this.state = 'IDLE';
      return res;
    }

    async cancel(commandId = null) {
      const targetCmd = commandId || this.activeCommandId;
      this._log('CANCEL_REQUESTED', { targetCommandId: targetCmd });
      try {
        let res;
        if (this._hasExtensionRuntime()) {
          res = await sendRuntimeMessage({
            type: 'SLEEPWALKER_STAGEHAND_CANCEL',
            tabId: this.activeTabId || undefined,
            commandId: targetCmd,
            bridgeUrl: this.options.bridgeUrl
          });
        } else {
          res = await this._directBridgeFetch('/cancel', 'POST', {
            commandId: targetCmd,
            forceDisconnect: true
          }, { timeoutMs: 3000 });
        }
        this.state = 'IDLE';
        this.activeCommandId = null;
        this._log('CANCELLED', { targetCommandId: targetCmd });
        return { ok: true, cancelled: true, commandId: targetCmd, details: res };
      } catch (err) {
        this.state = 'IDLE';
        this.activeCommandId = null;
        return { ok: false, cancelled: true, commandId: targetCmd, error: (err && err.message) || String(err) };
      }
    }
  }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { StagehandBrowserAdapter };
  }
  if (global) {
    global.StagehandBrowserAdapter = StagehandBrowserAdapter;
  }
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));
