/**
 * Sleepwalker 2.0 — Stage 4: Central Unified Browser & Desktop Orchestrator
 *
 * Single autonomous agent architecture:
 * - ONE central orchestrator (this module)
 * - ONE intent classification & backend routing pipeline
 * - ONE planning authority
 * - ONE unified command lifecycle FSM (with strict stale-command isolation)
 * - ONE cancellation mechanism propagating to both backends
 * - ONE shared verification system (SharedVerifier)
 * - TWO atomic execution backends: BrowserBackendAdapter & DesktopBackendAdapter
 *
 * Neither backend plans, interprets user intent, or runs an independent autonomous loop.
 */
(function (rootScope) {
  'use strict';

  const Contract = (typeof module !== 'undefined' && module.exports && typeof require === 'function')
    ? require('./unified-task-contract.js')
    : (rootScope && rootScope.SleepwalkerUnifiedContract);

  if (!Contract) {
    throw new Error('SleepwalkerUnifiedContract must be loaded before unified-orchestrator.js');
  }

  const {
    LIFECYCLE_STATES,
    TERMINAL_STATES,
    generateId,
    UnifiedLifecycleManager,
    createTaskRequest,
    SharedVerifier,
    BrowserBackendAdapter,
    DesktopBackendAdapter
  } = Contract;

  const SENSITIVE_PATTERNS = [
    /\b(?:password|passwd|passcode|pin|cvv|cvc|otp|one[- ]time[- ]password|secret[- ]key|api[-_ ]?key|bearer\s+[a-z0-9._-]+)\b/i,
    /\bAIza[0-9A-Za-z_-]{20,}\b/,
    /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}(?:\.[A-Za-z0-9_-]+)?\b/,
    /\b(?:sk|pk|ghp|gho|ghu|ghs)[_-][0-9A-Za-z_-]{16,}\b/,
    /\b(?:\d[ -]*?){13,19}\b/
  ];

  const COMMON_SITES = {
    youtube: 'https://www.youtube.com',
    google: 'https://www.google.com',
    wikipedia: 'https://en.wikipedia.org',
    github: 'https://github.com',
    python: 'https://www.python.org/downloads/',
    reddit: 'https://www.reddit.com',
    amazon: 'https://www.amazon.com',
    linkedin: 'https://www.linkedin.com'
  };

  const DESKTOP_APP_CATALOG = [
    { match: /\bnotepad\b/i, name: 'Notepad', executable: 'notepad.exe', processName: 'Notepad', titleContains: 'Notepad' },
    { match: /\b(?:windows\s+)?calc(?:ulator)?\b/i, name: 'Calculator', executable: 'calc.exe', processName: 'Calculator', titleContains: 'Calculator' },
    { match: /\bwindows\s+settings|settings\s+app\b/i, name: 'Settings', executable: 'ms-settings:', processName: 'SystemSettings', titleContains: 'Settings' },
    { match: /\bfile\s+explorer|windows\s+explorer\b/i, name: 'Explorer', executable: 'explorer.exe', processName: 'explorer', titleContains: 'File Explorer' }
  ];

  function containsSensitiveData(text) {
    const s = String(text || '');
    return SENSITIVE_PATTERNS.some((re) => re.test(s));
  }

  function scrubSensitive(text) {
    let s = String(text || '');
    for (const re of SENSITIVE_PATTERNS) {
      s = s.replace(new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`), '[REDACTED]');
    }
    return s;
  }

  function cosineSimilarity(a, b) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length === 0 || a.length !== b.length) return 0;
    let dot = 0;
    let na = 0;
    let nb = 0;
    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i];
      na += a[i] * a[i];
      nb += b[i] * b[i];
    }
    if (na === 0 || nb === 0) return 0;
    return dot / (Math.sqrt(na) * Math.sqrt(nb));
  }

  /**
   * Compact semantic memory helper backed by existing SleepwalkerMemory (in browser)
   * OR direct loopback Ollama nomic-embed-text:latest (in headless/Node orchestration tests).
   * Strictly enforces privacy scrubbing & top-K retrieval (never dumps full history).
   */
  class TargetedMemoryBridge {
    constructor(options = {}) {
      this.sleepwalkerMemory = options.memory || null;
      this.ollamaUrl = String(options.ollamaUrl || 'http://127.0.0.1:11434').replace(/\/+$/, '');
      this.embedModel = options.embedModel || 'nomic-embed-text:latest';
      this.maxEntries = options.maxEntries || 30;
      this.entries = []; // { id, text, backend, summary, timestamp, vector }
    }

    async _computeNomicEmbedding(text, timeoutMs = 1500) {
      if (typeof fetch !== 'function') return null;
      // Enforce loopback-only URL & approved embedding model at runtime boundary
      try {
        const u = new URL(this.ollamaUrl);
        const h = u.hostname.toLowerCase();
        if (u.protocol !== 'http:' || !['127.0.0.1', 'localhost', '::1', '[::1]'].includes(h)) {
          return null;
        }
      } catch (_e) {
        return null;
      }
      const allowedEmbed = (this.embedModel === 'nomic-embed-text:latest' || this.embedModel === 'nomic-embed-text')
        ? 'nomic-embed-text:latest'
        : null;
      if (!allowedEmbed) return null;
      const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
      const timer = ctrl ? setTimeout(() => ctrl.abort(), timeoutMs) : null;
      try {
        const res = await fetch(`${this.ollamaUrl}/api/embed`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: allowedEmbed, input: String(text || '').slice(0, 500) }),
          signal: ctrl ? ctrl.signal : undefined
        });
        if (res.ok) {
          const data = await res.json();
          const vec = Array.isArray(data.embeddings) && Array.isArray(data.embeddings[0])
            ? data.embeddings[0]
            : (Array.isArray(data.embedding) ? data.embedding : null);
          if (vec && vec.length > 0) return { vec, model: this.embedModel, source: 'ollama_nomic' };
        }
      } catch (_e) {
        // Fallback cleanly to lexical similarity if Ollama embeddings are unavailable
      } finally {
        if (timer) clearTimeout(timer);
      }
      return null;
    }

    async recordCommandOutcome(entry = {}) {
      const rawText = String(entry.commandText || '').trim();
      if (!rawText || containsSensitiveData(rawText)) {
        return { stored: false, reason: 'sensitive_or_empty_filtered' };
      }
      const cleanSummary = scrubSensitive(String(entry.summary || rawText).slice(0, 220));

      // Prefer existing SleepwalkerMemory when present
      if (this.sleepwalkerMemory && typeof this.sleepwalkerMemory.recordActivity === 'function') {
        try {
          await this.sleepwalkerMemory.recordActivity({
            type: 'unified_command',
            title: cleanSummary,
            text: rawText,
            backend: entry.backend || 'browser',
            status: entry.status || 'COMPLETED',
            url: entry.url || ''
          });
        } catch (_e) {}
      }

      const emb = await this._computeNomicEmbedding(`${rawText} ${cleanSummary}`, 1000);
      this.entries.unshift({
        id: entry.commandId || generateId('mem'),
        text: rawText,
        summary: cleanSummary,
        backend: entry.backend || 'none',
        status: entry.status || 'COMPLETED',
        timestamp: new Date().toISOString(),
        vector: emb ? emb.vec : null,
        embedModel: emb ? emb.model : 'lexical'
      });
      if (this.entries.length > this.maxEntries) this.entries.pop();
      return { stored: true, embedModel: emb ? emb.model : 'lexical' };
    }

    async retrieveRelevant(queryText, { topK = 3, timeoutMs = 1200 } = {}) {
      const q = String(queryText || '').trim();
      if (!q) return { items: [], embedModel: 'none', usedNomic: false };

      const combined = [];
      let usedNomic = false;
      let embedModel = 'lexical';

      // 1. Existing SleepwalkerMemory semantic retrieval (uses nomic-embed-text via background.js)
      if (this.sleepwalkerMemory && typeof this.sleepwalkerMemory.retrieveRelevantMemoriesAsync === 'function') {
        try {
          const hits = await this.sleepwalkerMemory.retrieveRelevantMemoriesAsync(q, { topK, timeoutMs });
          if (Array.isArray(hits)) {
            for (const h of hits.slice(0, topK)) {
              if (h && h.vectorModel && /nomic/i.test(h.vectorModel)) {
                usedNomic = true;
                embedModel = h.vectorModel;
              }
              combined.push({
                source: 'sleepwalker_memory',
                text: scrubSensitive(String((h && (h.summary || h.title || h.text)) || '').slice(0, 180)),
                score: Number((h && h.score) || 0.5)
              });
            }
          }
        } catch (_e) {}
      }

      // 2. Local semantic entries with Nomic embeddings
      if (this.entries.length > 0) {
        const qEmb = await this._computeNomicEmbedding(q, Math.min(timeoutMs, 1000));
        if (qEmb && qEmb.vec) {
          usedNomic = true;
          embedModel = qEmb.model;
        }
        const qWords = new Set(q.toLowerCase().split(/\W+/).filter((w) => w.length > 2));
        for (const item of this.entries) {
          let score = 0;
          if (qEmb && qEmb.vec && item.vector) {
            score = cosineSimilarity(qEmb.vec, item.vector);
          } else {
            const words = item.text.toLowerCase().split(/\W+/).filter((w) => w.length > 2);
            const overlap = words.filter((w) => qWords.has(w)).length;
            score = qWords.size > 0 ? overlap / Math.max(qWords.size, words.length, 1) : 0;
          }
          if (score > 0.15) {
            combined.push({
              source: item.vector ? 'nomic_semantic_memory' : 'lexical_memory',
              text: item.summary,
              backend: item.backend,
              score: Math.round(score * 1000) / 1000
            });
          }
        }
      }

      combined.sort((a, b) => b.score - a.score);
      return {
        items: combined.slice(0, topK),
        embedModel,
        usedNomic
      };
    }
  }

  // =========================================================================
  // CENTRAL UNIFIED ORCHESTRATOR
  // =========================================================================
  class SleepwalkerUnifiedOrchestrator {
    constructor(options = {}) {
      this.controller = options.controller || null;
      this.browserBackend = options.browserBackend || new BrowserBackendAdapter({
        controller: this.controller,
        stagehandAdapter: options.stagehandAdapter || (this.controller && this.controller.stagehandAdapter) || null,
        browserEngine: options.browserEngine || (this.controller && this.controller.browserEngine) || null
      });
      this.desktopBackend = options.desktopBackend || new DesktopBackendAdapter({
        transport: options.desktopTransport || null
      });
      this.verifier = options.verifier || new SharedVerifier();
      this.memoryBridge = options.memoryBridge || new TargetedMemoryBridge({
        memory: options.memory || (this.controller && this.controller.memory) || null,
        ollamaUrl: options.ollamaUrl || 'http://127.0.0.1:11434'
      });
      this.lifecycle = new UnifiedLifecycleManager({
        onChange: (snapshot, entry) => this._handleLifecycleChange(snapshot, entry)
      });
      this.onLifecycleChange = typeof options.onLifecycleChange === 'function' ? options.onLifecycleChange : null;
      this.activeAbortController = null;
      this.activeCommandId = null;
      this.activeTaskId = null;
      this.defaultTimeoutMs = Number(options.defaultTimeoutMs || 18000);
      this.maxStepRetries = Number.isFinite(options.maxStepRetries) ? options.maxStepRetries : 1;
      this.executionHistory = [];
      this.routingHistory = [];
    }

    _handleLifecycleChange(snapshot, entry) {
      if (this.onLifecycleChange) {
        try {
          this.onLifecycleChange(snapshot, entry);
        } catch (_e) {}
      }
      // Automatically keep Sleepwalker's existing Orb status bar in sync (non-blocking, zero redesign)
      if (typeof window !== 'undefined' && window.SW_UI && typeof window.SW_UI.setTaskStatus === 'function') {
        const uiStateMap = {
          IDLE: 'idle',
          LISTENING: 'processing',
          UNDERSTANDING: 'processing',
          GATHERING_CONTEXT: 'observing',
          PLANNING: 'processing',
          RESOLVING_TARGET: 'observing',
          EXECUTING: 'executing',
          VERIFYING: 'observing',
          RECOVERING: 'processing',
          WAITING_FOR_USER: 'waiting_for_clarification',
          COMPLETED: 'completed',
          CANCELLED: 'cancelled',
          FAILED: 'error',
          TIMEOUT: 'error'
        };
        const backendBadgeMap = {
          browser: 'Browser',
          desktop: 'Desktop',
          cross_backend: 'Browser + Desktop',
          none: ''
        };
        const stepSuffix = snapshot.totalSteps > 1 && snapshot.currentStepIndex > 0
          ? ` (${snapshot.currentStepIndex}/${snapshot.totalSteps})`
          : '';
        const stageLabels = {
          IDLE: '',
          LISTENING: 'Listening',
          UNDERSTANDING: 'Understanding request',
          GATHERING_CONTEXT: 'Gathering context',
          PLANNING: 'Planning steps',
          RESOLVING_TARGET: `Resolving target${stepSuffix}`,
          EXECUTING: `Executing${stepSuffix}`,
          VERIFYING: `Verifying${stepSuffix}`,
          RECOVERING: `Recovering${stepSuffix}`,
          WAITING_FOR_USER: 'Needs your input',
          COMPLETED: snapshot.totalSteps > 1 ? `Completed (${snapshot.completedSteps.length}/${snapshot.totalSteps})` : 'Completed',
          CANCELLED: 'Cancelled',
          FAILED: 'Action failed',
          TIMEOUT: 'Timed out'
        };
        const detailText = snapshot.state === 'WAITING_FOR_USER'
          ? (snapshot.userPrompt || snapshot.understoodSummary)
          : (snapshot.state === 'FAILED' || snapshot.state === 'TIMEOUT'
            ? (snapshot.lastError || entry.detail || snapshot.understoodSummary)
            : (entry.detail || snapshot.understoodSummary));

        window.SW_UI.setTaskStatus({
          state: uiStateMap[snapshot.state] || 'processing',
          lifecycleState: snapshot.state,
          stage: stageLabels[snapshot.state] || snapshot.state,
          taskLabel: String(detailText || '').slice(0, 72),
          observationSource: backendBadgeMap[snapshot.backend] || '',
          backend: snapshot.backend,
          understood: snapshot.understoodSummary,
          completedCount: snapshot.completedSteps.length,
          totalSteps: snapshot.totalSteps
        });
      }
    }

    /**
     * Detect whether a user utterance should be handled by the Unified Orchestrator
     * (desktop-only, cross-backend, or unified browser workflows).
     */
    isDesktopOrCrossBackendIntent(rawText = '') {
      const routing = this.classifyAndRoute(rawText, {});
      return routing.route === 'desktop' || routing.route === 'cross_backend';
    }

    /**
     * Single-authority check used by handleUserInput() in content.js so pure browser,
     * desktop, and cross-backend commands all flow through SleepwalkerUnifiedOrchestrator
     * instead of bypassing to legacy content.js execution paths.
     */
    shouldHandleCommand(rawText = '', context = {}) {
      const text = String(rawText || '').trim();
      if (!text) return false;
      // Leave specialized accessibility/reading/reminder/upload/dialogue/reset controls to dedicated handlers
      if (/^(?:read\s+(?:this|the\s+page|aloud|section)|stop\s+reading|pause\s+reading|resume\s+reading|reset\s+emergency\s+stop|resume(?:\s+assistant)?$|scroll\s+(?!.+\s+and\s+(?:click|open|select|extract|inspect|fill)\b)|go\s+back\b|go\s+forward\b|remind\s+me\b|upload\s+|teach\s+|fill\s+my\s+details|you\s+can\s+rest|goodbye|bye\b)/i.test(text)) {
        return false;
      }
      const routing = this.classifyAndRoute(text, context, { dryRun: true });
      if (routing.route === 'desktop' || routing.route === 'cross_backend') return true;
      if (routing.route === 'browser') {
        const unifiedBrowserIntents = new Set([
          'BROWSER_NAVIGATE',
          'BROWSER_SEARCH_AND_SELECT',
          'BROWSER_HIERARCHICAL_WORKFLOW',
          'BROWSER_SEARCH_SITE',
          'BROWSER_SEARCH',
          'BROWSER_CLICK',
          'BROWSER_FILL',
          'BROWSER_FORM_FILL_SUBMIT',
          'BROWSER_SCROLL_AND_ACT',
          'BROWSER_SCROLL',
          'BROWSER_TAB_LIST',
          'BROWSER_TAB_SWITCH',
          'BROWSER_SUMMARIZE'
        ]);
        if (unifiedBrowserIntents.has(routing.intent)) return true;
        if (routing.intent === 'BROWSER_EXTRACT' && Number(routing.confidence || 0) >= 0.9) return true;
      }
      // Route target-ambiguous action commands (e.g., "Type hello world", "Save this document", "Write meeting notes")
      // or natural-language browser/desktop requests into UnifiedOrchestrator for WAITING_FOR_USER / local Qwen 2.5 fallback!
      if (routing.route === 'clarification' && /\b(?:type|write|jot(?:\s+down)?|enter|save|paste|put|record|calculate|compute|summarize|overview|gist)\b/i.test(text)) {
        return true;
      }
      return false;
    }

    /**
     * Single Intent Classification & Backend Router (Section 3).
     * Decides whether a command needs Browser only, Desktop only, Cross-Backend, or Clarification.
     * Also enforces routing guardrails if an explicit/wrong backend hint is supplied (Scenario 12).
     */
    classifyAndRoute(rawText = '', context = {}, options = {}) {
      const text = String(rawText || '').trim();
      const lower = text.toLowerCase();

      const matchedDesktopApp = DESKTOP_APP_CATALOG.find((app) => app.match.test(text)) || null;
      const activeDesktopProc = (context && context.desktop && context.desktop.activeWindow && context.desktop.activeWindow.processName) || '';
      const hasDesktopVerb = /\b(?:notepad|calculator|calc\.exe|windows\s+settings|save\s+(?:a\s+|the\s+)?(?:local\s+)?file(?:\s+to\s+\w+)?|save\s+as\s+dialog|desktop\s+(?:app|application|document|window)|local\s+(?:document|file)|file\s+explorer|write\s+(?:a\s+)?(?:short\s+)?note|type\s+into\s+(?:notepad|desktop|local)|write\s+(?:it|that|the\s+[\w\s]+?)\s+(?:into|to|in)\s+(?:notepad|a\s+desktop\s+document|local\s+document)|read\s+(?:the\s+)?(?:text|contents|info|information|content)?\s*(?:of|from)\s+(?:notepad|this\s+document|local\s+document|desktop))\b/i.test(text);
      const hasBrowserVerb = /^(?:select|choose|pick|click|tap)\s+(?:on\s+)?(?:the\s+)?[a-z0-9]/i.test(text) || /^(?:switch|change|turn)\s+(?:to|on|off)\s+(?:dark|light|device|restricted|ambient)\b/i.test(text) || /^(?:set|change)\s+(?:the\s+)?(?:playback\s+speed|video\s+quality|quality|theme|appearance|language)\s+(?:to\s+)?/i.test(text) || /^(?:what|list|show)\s+(?:are\s+)?(?:the\s+)?(?:options|items|settings|choices|sub[- ]?options)\s+(?:are\s+)?(?:available\s+)?(?:under|in|inside|for)\s+/i.test(text) || /^(?:under|in|inside|from)\s+.+?\b(?:select|choose|pick|click|open)\b/i.test(text) || /\s*(?:>|->|→|»)\s*[a-z0-9]/i.test(text) || /\b(?:open|expand)\s+[a-z0-9 _-]+?\s+(?:and|then)\s+(?:select|choose|pick|click|open)\b/i.test(text) || /\b(?:youtube|google|wikipedia|github|website|webpage|web\s+form|browser|chrome|shadow\s+dom|submit\s+(?:the\s+)?form|inspect\s+(?:the\s+)?(?:first|top|\d+)|compare\s+(?:their\s+|the\s+)?(?:titles|results)|most\s+relevant\s+result|best\s+match|filter\s+(?:for|by)\b|set\s+(?:the\s+)?(?:price|budget|range|limit|slider|max|min)\b|(?:expand|collapse|toggle|hover(?:\s+over)?|double[- ]click|right[- ]click)\s+(?:the\s+)?[a-z0-9]+|press\s+(?:tab|shift\+tab|enter|escape|space|arrow(?:up|down|left|right))|(?:open|select|choose|switch\s+to)\s+(?:the\s+)?[a-z0-9 _-]+\s+(?:category|menu|submenu|dropdown|tab|accordion|section|option|filter|checkbox|radio)\b|(?:select|choose|pick|check|uncheck|enable|disable|click|open)\s+.+?\s+(?:under|in|inside|from|for)\s+[a-z0-9]+|scroll\s+.+\s+and\s+(?:click|open|select|extract|inspect|fill)|(?:use|in)\s+the\s+[\w\s]+?\s+search\s*(?:box|bar|field|input)|search\s+(?:youtube|the\s+web|online|on\s+youtube|on\s+google|on\s+wikipedia|for\s+)|https?:\/\/|www\.|\.(?:com|org|net|io|dev|gov|edu)\b|(?:click|press|tap)\s+(?:on\s+)?(?:the\s+)?[a-z0-9]+|navigate\s+(?:between\s+)?tabs?|switch\s+tab|list\s+tabs|extract\s+(?:webpage|page|visible)|summarize(?:\s+(?:this|the)\s+(?:webpage|page|article))?|summary\s+of\s+(?:this|the)\s+(?:webpage|page|article)|what\s+is\s+this\s+(?:webpage|page|article)\s+about|fill\s+(?:the\s+|this\s+|a\s+|in\s+|out\s+)?(?:web\s+)?(?:form|[a-z0-9_ ]+\s*(?:with|:|=)\b)|open\s+(?:youtube|google|wikipedia|github|python\.org|reddit|amazon|linkedin|account|profile|settings|youtube\s+studio|the\s+first\s+(?:relevant\s+)?result)|find\s+(?:the\s+)?(?:[\w\s]*search\s+box|.+?\s+(?:page|link|button)\s+and\s+(?:open|click)\s+it)|contact\s+page)\b/i.test(text);

      // 1. Cross-backend workflows (BOTH browser AND desktop indicators!)
      const isDesktopToBrowser = Boolean(
        /\b(?:read|get|take|copy|extract)\b.+\b(?:notepad|local\s+document|desktop\s+document|this\s+document)\b.+\b(?:search|look\s+up|find|open|google|wikipedia|youtube|online|web|browser|chrome|related\s+information)\b/i.test(text)
      );
      const isBrowserToDesktop = Boolean(
        !isDesktopToBrowser && (
          (/\b(?:search\s+(?:the\s+web|online|for)|visit\s+(?:a\s+)?(?:website|site|page)|open\s+(?:a\s+|this\s+)?(?:website|webpage|site|https?:\/\/)|extract|collect|from\s+chrome|from\s+(?:this\s+)?(?:page|webpage|website))\b.+\b(?:notepad|desktop\s+document|local\s+file|save\s+(?:it|its\s+[\w\s]+?)\s+(?:in|to)\s+(?:a\s+)?(?:desktop|local)|write\s+.+\s+(?:into|in)\s+notepad|put\s+it\s+in\s+notepad)\b/i.test(text)) ||
          (/\b(?:open\s+notepad|launch\s+notepad)\b.+\b(?:search|web|online|website|chrome|extract|python\s+release)\b/i.test(text)) ||
          (matchedDesktopApp && hasBrowserVerb)
        )
      );

      let decision;
      if (isDesktopToBrowser) {
        decision = {
          route: 'cross_backend',
          direction: 'desktop_to_browser',
          backends: ['desktop', 'browser'],
          intent: 'CROSS_DESKTOP_TO_BROWSER',
          desktopApp: matchedDesktopApp || DESKTOP_APP_CATALOG[0],
          confidence: 0.94,
          understoodSummary: `Read from ${(matchedDesktopApp && matchedDesktopApp.name) || 'Notepad'} and search online in browser`,
          rationale: 'Command requires reading desktop application content first, then querying the browser.'
        };
      } else if (isBrowserToDesktop) {
        decision = {
          route: 'cross_backend',
          direction: 'browser_to_desktop',
          backends: ['browser', 'desktop'],
          intent: 'CROSS_BROWSER_TO_DESKTOP',
          desktopApp: matchedDesktopApp || DESKTOP_APP_CATALOG[0],
          confidence: 0.95,
          understoodSummary: `Collect verified web info and write into ${(matchedDesktopApp && matchedDesktopApp.name) || 'Notepad'}`,
          rationale: 'Command requires browser extraction/search followed by verified desktop application entry.'
        };
      } else if (matchedDesktopApp || hasDesktopVerb) {
        const desktopIntent = this._classifyDesktopSubIntent(text, matchedDesktopApp);
        decision = {
          route: 'desktop',
          direction: 'desktop_only',
          backends: ['desktop'],
          intent: desktopIntent.intent,
          desktopApp: matchedDesktopApp || desktopIntent.desktopApp,
          subDetails: desktopIntent,
          confidence: 0.93,
          understoodSummary: desktopIntent.summary,
          rationale: `Matched Windows desktop target (${(matchedDesktopApp && matchedDesktopApp.name) || 'desktop app'}).`
        };
      } else if (hasBrowserVerb || this._looksLikeBrowserPageAction(text, context)) {
        const browserIntent = this._classifyBrowserSubIntent(text, context);
        decision = {
          route: 'browser',
          direction: 'browser_only',
          backends: ['browser'],
          intent: browserIntent.intent,
          subDetails: browserIntent,
          confidence: browserIntent.confidence,
          understoodSummary: browserIntent.summary,
          rationale: browserIntent.rationale
        };
      } else {
        // Ambiguous command with no clear browser or desktop target
        decision = {
          route: 'clarification',
          direction: 'ambiguous',
          backends: [],
          intent: 'AMBIGUOUS_TARGET',
          confidence: 0.25,
          ambiguous: true,
          understoodSummary: `Unclear target: "${text.slice(0, 60)}"`,
          clarificationQuestion: `Should I perform "${text}" in your browser or in a Windows desktop application (such as Notepad or Calculator)?`,
          rationale: 'Insufficient browser or desktop target signals; refusing blind routing.'
        };
      }

      // Routing guardrail (Scenario 12: detect and guard against incorrect backend routing!)
      if (options.requestedBackend && options.requestedBackend !== decision.route && decision.route !== 'clarification') {
        const incompatible = (
          (options.requestedBackend === 'browser' && decision.route === 'desktop') ||
          (options.requestedBackend === 'desktop' && decision.route === 'browser')
        );
        if (incompatible) {
          decision.routingGuardTriggered = true;
          decision.rejectedBackend = options.requestedBackend;
          decision.routingCorrectionReason = `Rejected requested backend '${options.requestedBackend}' because intent '${decision.intent}' requires '${decision.route}'`;
          if (options.strictRejectMismatch) {
            decision.route = 'mismatch_rejected';
          }
        }
      }

      if (!options.dryRun) {
        this.routingHistory.push({
          timestamp: new Date().toISOString(),
          input: text,
          route: decision.route,
          intent: decision.intent,
          direction: decision.direction,
          confidence: decision.confidence,
          routingGuardTriggered: Boolean(decision.routingGuardTriggered),
          rejectedBackend: decision.rejectedBackend || null
        });
        if (this.routingHistory.length > 100) this.routingHistory.shift();
      }

      return decision;
    }

    _looksLikeBrowserPageAction(text, context = {}) {
      // Do NOT blindly route bare targetless commands ("Type hello", "Write a note", "Save this") to browser just because a URL exists;
      // require an explicit browser/DOM noun so targetless commands trigger WAITING_FOR_USER clarification!
      if (/\b(?:click|tap|press|fill|enter|type|search|extract|read|scroll|open|go\s+to|navigate|back|forward|tab)\b/i.test(text)) {
        if (/\b(?:link|button|page|webpage|form|field|input|search\s*box|heading|article|video|tab|url|site|website|browser|chrome|result)\b/i.test(text)) {
          return true;
        }
      }
      return false;
    }

    _classifyDesktopSubIntent(text, app) {
      const lower = text.toLowerCase();
      const calcMatch = text.match(/(\d+)\s*([+\-*/x×]|multiplied\s+by|times|plus|minus|divided\s+by)\s*(\d+)/i);
      if ((app && app.name === 'Calculator') && calcMatch) {
        const rawOp = calcMatch[2].toLowerCase().replace(/\s+/g, ' ').trim();
        const opNorm = rawOp === 'multiplied by' || rawOp === 'times' ? '*'
          : (rawOp === 'plus' ? '+' : (rawOp === 'minus' ? '-' : (rawOp === 'divided by' ? '/' : rawOp)));
        return {
          intent: 'DESKTOP_CALCULATE',
          desktopApp: app,
          a: calcMatch[1],
          op: opNorm,
          b: calcMatch[3],
          summary: `Calculate ${calcMatch[1]} ${opNorm} ${calcMatch[3]} in Windows Calculator`
        };
      }
      if (/^\s*(?:switch\s+to|focus|bring\s+up|go\s+back\s+to)\s+/i.test(text) && app) {
        return {
          intent: 'DESKTOP_ACTIVATE_WINDOW',
          desktopApp: app,
          summary: `Switch to ${app.name}`
        };
      }
      if (/\bwrite\s+(?:a\s+)?(?:short\s+)?note\b/i.test(text)) {
        const quoted = text.match(/["']([^"']+)["']/);
        return {
          intent: 'DESKTOP_TYPE_ACTIVE',
          desktopApp: app || DESKTOP_APP_CATALOG[0],
          textToType: quoted ? quoted[1].trim() : 'Sleepwalker 2.0 Stage 5 verification note.',
          summary: 'Write short note into Notepad'
        };
      }
      if (
        /\b(?:type|write)\b.+\b(?:into|in)\s+(?:notepad|desktop|local)\b/i.test(text) ||
        /\b(?:open|launch|start|switch\s+to)\s+(?:windows\s+)?notepad\b.+\b(?:type|write|enter)\s+(.+)/i.test(text)
      ) {
        const quoted = text.match(/["']([^"']+)["']/);
        const afterVerb = text.match(/\b(?:type|write|enter)\s+(.+?)(?:\s+(?:into|in)\s+(?:notepad|desktop|local))?[.?!]?$/i);
        const extracted = quoted
          ? quoted[1].trim()
          : (afterVerb ? afterVerb[1].trim().replace(/^["']|["']$/g, '') : 'Sleepwalker unified desktop text.');
        return {
          intent: 'DESKTOP_LAUNCH_AND_TYPE',
          desktopApp: app || DESKTOP_APP_CATALOG[0],
          textToType: extracted || 'Sleepwalker unified desktop text.',
          summary: `Open ${(app && app.name) || 'Notepad'} and type verified text`
        };
      }
      if (/\bsave\b.+\b(?:file|dialog|document|documents)\b/i.test(lower)) {
        const pathMatch = text.match(/([A-Za-z]:\\[^\s"']+\.txt)/);
        const toDocuments = /\bdocuments\b/i.test(lower);
        return {
          intent: 'DESKTOP_SAVE_DIALOG',
          desktopApp: app || DESKTOP_APP_CATALOG[0],
          savePath: pathMatch ? pathMatch[1] : null,
          toDocuments,
          summary: toDocuments ? 'Save file to Documents via Save As dialog' : 'Save local file via Windows Save As dialog'
        };
      }
      if (/\bread\b.+\b(?:notepad|desktop|local|this\s+document)\b/i.test(lower)) {
        return {
          intent: 'DESKTOP_READ_TEXT',
          desktopApp: app || DESKTOP_APP_CATALOG[0],
          summary: `Read text from ${(app && app.name) || 'Notepad'} via UI Automation`
        };
      }
      const targetApp = app || DESKTOP_APP_CATALOG[0];
      return {
        intent: 'DESKTOP_LAUNCH_APP',
        desktopApp: targetApp,
        summary: `Launch and focus ${targetApp.name}`
      };
    }

    _classifyBrowserSubIntent(text, context = {}) {
      const lower = text.toLowerCase();
      const wordNums = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };

      // 0. Compound Chromium Search + Result Inspection + Local AI Comparison + Best Result Open
      // e.g., "Open YouTube, search for Python machine learning tutorials, inspect the first five results, compare their titles and descriptions, and open the most relevant result."
      const hasInspectOrCompare = /\b(?:inspect\s+(?:the\s+)?(?:first|top|\d+|one|two|three|four|five|six|seven|eight|nine|ten)|compare\s+(?:their\s+)?(?:titles|results|descriptions)|(?:open|select|click|choose)\s+(?:the\s+)?(?:most\s+relevant|best(?:\s+matching)?)\s+(?:result|video|link|tutorial|article))\b/i.test(text);
      const openThenSearch = text.match(/\b(?:open|go\s+to|visit)\s+(youtube|wikipedia|google|github|[a-z0-9.-]+\.[a-z]{2,})\b(?:[,\s]+(?:and\s+)?|\s+then\s+)search\s+(?:for\s+)?(.+)/i);
      if (openThenSearch || (hasInspectOrCompare && /\bsearch\b/i.test(text))) {
        let siteRaw = openThenSearch ? openThenSearch[1].toLowerCase().replace(/[.,!?;]+$/, '') : '';
        if (!siteRaw) {
          if (/\byoutube\b/i.test(text)) siteRaw = 'youtube';
          else if (/\bwikipedia\b/i.test(text)) siteRaw = 'wikipedia';
          else if (/\bgithub\b/i.test(text)) siteRaw = 'github';
          else siteRaw = 'current';
        }
        const siteUrl = COMMON_SITES[siteRaw] || (/\./.test(siteRaw) ? `https://${siteRaw}` : null);
        let rawRemainder = openThenSearch
          ? openThenSearch[2]
          : ((text.match(/\bsearch\s+(?:(?:on|in)\s+[a-z0-9.-]+\s+)?(?:for\s+)?(.+)/i) || [])[1] || text);
        const cleanQuery = rawRemainder
          .split(/(?:,\s*|\s+and\s+|\s+then\s+)(?:inspect|compare|pick|choose|select|open\s+(?:the\s+)?(?:most\s+relevant|best|first))\b/i)[0]
          .replace(/\s+(?:on|in)\s+(?:youtube|wikipedia|google|github)\b/i, '')
          .trim()
          .replace(/^["']|["']$/g, '')
          .replace(/[.,!?;]+$/, '');

        const countMatch = text.match(/\b(?:first|top)\s+(\d+|one|two|three|four|five|six|seven|eight|nine|ten)\s+(?:relevant\s+)?results?\b/i);
        const rawCnt = countMatch ? countMatch[1].toLowerCase() : '5';
        const inspectCount = Number(wordNums[rawCnt] || rawCnt || 5);
        const compareResults = /\bcompare\b/i.test(text) || /\bmost\s+relevant|best\b/i.test(text);
        const openBestResult = /\b(?:open|click|select|choose)\s+(?:the\s+)?(?:most\s+relevant|best(?:\s+matching)?|first(?:\s+relevant)?)\s+(?:result|video|link|tutorial|article)\b/i.test(text);
        const fieldHintMatch = text.match(/\b(?:use|in)\s+the\s+([a-z0-9 _-]+?)\s+search\s*(?:box|bar|field|input)\b/i);

        return {
          intent: 'BROWSER_SEARCH_AND_SELECT',
          site: siteRaw,
          siteUrl,
          fieldHint: fieldHintMatch ? fieldHintMatch[1].trim() : (siteRaw === 'youtube' ? 'YouTube search' : 'search'),
          query: cleanQuery || 'Python machine learning tutorials',
          inspectCount: Math.max(1, Math.min(10, inspectCount)),
          compareResults,
          openBestResult,
          confidence: 0.97,
          summary: `${siteUrl ? `Open ${siteRaw}, s` : 'S'}earch for "${cleanQuery}"${compareResults ? `, compare top ${inspectCount} results` : ''}${openBestResult ? ', and open the best match' : ''}`,
          rationale: 'Multi-step interactive Chromium search, result comparison, and selection workflow.'
        };
      }

      // 0a. Hierarchical interactive webpage workflow (menus, categories, dropdowns, filters, tabs, accordions, price thresholds, multi-step controls)
      const hierParsed = this._parseHierarchicalClauses(text);
      if (hierParsed && hierParsed.isHierarchical) {
        return {
          intent: 'BROWSER_HIERARCHICAL_WORKFLOW',
          clauses: hierParsed.clauses,
          compareResults: hierParsed.compareResults,
          openBestResult: hierParsed.openBestResult,
          confidence: 0.96,
          summary: hierParsed.summary,
          rationale: 'Hierarchical interactive webpage control workflow with dynamic World Model discovery and post-action reinspection.'
        };
      }

      // 0b. Compound Scroll + Action ("Scroll down to Shadow Controls and click Enable Telemetry")
      const scrollAndAct = text.match(/^scroll\s+(?:(down|up|to\s+bottom|to\s+top)|(?:down\s+)?to\s+(?:the\s+)?(.+?)(?:\s+section|\s+panel|\s+area)?)\s+and\s+(click|open|select|extract|inspect)\s+(?:the\s+|on\s+)?(.+?)[.?!]?$/i);
      if (scrollAndAct) {
        const scrollDirOrTarget = (scrollAndAct[2] || scrollAndAct[1] || 'down').trim();
        const nextVerb = scrollAndAct[3].toLowerCase();
        const nextTarget = scrollAndAct[4].trim().replace(/\s+(?:button|link)$/i, '').replace(/^["']|["']$/g, '');
        return {
          intent: 'BROWSER_SCROLL_AND_ACT',
          scrollTarget: scrollDirOrTarget,
          nextAction: (nextVerb === 'extract' || nextVerb === 'inspect') ? 'extract' : 'click',
          actionTarget: nextTarget,
          confidence: 0.94,
          summary: `Scroll to "${scrollDirOrTarget}" and ${nextVerb} "${nextTarget}"`,
          rationale: 'Compound browser scroll + interaction intent.'
        };
      }

      // 0c. Multi-field form fill + optional submit
      // Supports:
      //  - "Fill Full Name with Ada Lovelace, Email with ada@example.org, and submit the form"
      //  - "Fill this form with Name: Alex, Email: alex@example.com, Address: 123 Main St, Phone number: 555-0100"
      if (/^(?:please\s+)?fill\b/i.test(text) && (/,|;|\band\s+(?:submit|click|press|fill)\b|\band\s+[A-Za-z][A-Za-z0-9 _-]*\s*(?:with|as|=|:)\s*/i.test(text) || /:\s*\S+/.test(text))) {
        const hasSubmit = /\band\s+(?:submit(?:\s+(?:the|this)\s+form|\s+it)?|(?:click|press)\s+(?:the\s+)?(?:submit|register|send|apply|save|continue)(?:\s+button)?)\s*[.?!]?$/i.test(text);
        const submitBtnMatch = text.match(/\band\s+(?:click|press)\s+(?:the\s+)?([A-Za-z0-9 _-]+?)(?:\s+button)?\s*[.?!]?$/i);
        const submitLabel = submitBtnMatch ? submitBtnMatch[1].trim() : (hasSubmit ? 'Submit' : null);
        const bodyWithoutSubmit = text
          .replace(/^(?:please\s+)?fill(?:\s+out|\s+in)?(?:\s+(?:the|this)\s+(?:web\s+)?form\s*(?:with|:)?)?\s*/i, '')
          .replace(/\s*,?\s*\band\s+(?:submit(?:\s+(?:the|this)\s+form|\s+it)?|(?:click|press)\s+(?:the\s+)?[A-Za-z0-9 _-]+?(?:\s+button)?)\s*[.?!]?$/i, '')
          .trim();
        // Split only before a new "FieldLabel with/as/=/:" clause so commas inside addresses ("123 Main St, Austin") stay intact!
        const rawClauses = bodyWithoutSubmit.split(/\s*(?:,\s*and\s+|;\s*|\s+and\s+(?=[A-Za-z][A-Za-z0-9 _-]{0,30}\s*(?:with|as|=|:)\s+)|,\s*(?=(?:fill\s+)?(?:the\s+)?[A-Za-z][A-Za-z0-9 _-]{0,30}\s*(?:with|as|=|:)\s+))\s*/i);
        const fields = [];
        for (const cl of rawClauses) {
          const m = cl.match(/^(?:fill\s+)?(?:the\s+)?(?:field\s+)?([A-Za-z][A-Za-z0-9 _/-]{0,40}?)\s*(?:\bwith\b|\bas\b|=|:)\s*["']?([^"']+?)["']?[.?!]?$/i);
          if (m) {
            fields.push({ label: m[1].trim(), value: m[2].trim() });
          }
        }
        if (fields.length >= 2 || (fields.length >= 1 && hasSubmit)) {
          return {
            intent: 'BROWSER_FORM_FILL_SUBMIT',
            fields,
            submit: Boolean(hasSubmit),
            submitLabel,
            confidence: 0.95,
            summary: `Fill ${fields.length} form field${fields.length === 1 ? '' : 's'}${hasSubmit ? ' and submit form' : ''}`,
            rationale: 'Multi-step web form fill intent.'
          };
        }
      }

      // YouTube search (supports single-step "Search YouTube for X", "Search for X on YouTube", "YouTube search X")
      const ytSearch = text.match(/search\s+youtube\s+(?:for\s+)?(.+?)[.?!]?$/i) ||
                       text.match(/search\s+(?:for\s+)?(.+?)\s+on\s+youtube[.?!]?$/i) ||
                       text.match(/youtube\s+search\s+(?:for\s+)?(.+?)[.?!]?$/i);
      if (ytSearch) {
        const q = ytSearch[1].trim().replace(/^["']|["']$/g, '').replace(/[.?!]+$/, '');
        return {
          intent: 'BROWSER_SEARCH_SITE',
          site: 'youtube',
          query: q,
          url: `https://www.youtube.com/results?search_query=${encodeURIComponent(q)}`,
          confidence: 0.96,
          summary: `Search YouTube for "${q}"`,
          rationale: 'Explicit YouTube web search intent.'
        };
      }

      // Targeted on-page search box disambiguation ("Use the documentation search box to search for async iterators", "Find the catalog search box and search for keyboards")
      const targetedBoxSearch = text.match(/(?:use|in|find)\s+(?:the\s+)?([a-z0-9 _-]+?)\s*search\s*(?:box|bar|field|input)?\s+(?:to\s+|and\s+)?search\s+(?:for\s+)?(.+?)[.?!]?$/i);
      if (targetedBoxSearch) {
        const fieldHint = targetedBoxSearch[1].trim() || 'search';
        const q = targetedBoxSearch[2].trim().replace(/^["']|["']$/g, '').replace(/[.?!]+$/, '');
        return {
          intent: 'BROWSER_SEARCH',
          fieldHint,
          onPageOnly: true,
          query: q,
          url: '',
          confidence: 0.95,
          summary: `Search "${fieldHint}" field for "${q}"`,
          rationale: 'Targeted on-page search box disambiguation intent.'
        };
      }

      // Generic web search (prefer the last "search for X" clause so "Find the search box and search for AI" -> "AI")
      const webSearch = text.match(/(?:.*\b)?search\s+(?:the\s+web\s+|online\s+|google\s+|wikipedia\s+)?for\s+(.+?)(?:\s+online|\s+on\s+(?:google|wikipedia))?[.?!]?$/i) ||
                        text.match(/search\s+(?:the\s+web\s+|online\s+|google\s+|wikipedia\s+)(.+?)(?:\s+online|\s+on\s+(?:google|wikipedia))?[.?!]?$/i);
      if (/\bsearch\b/i.test(lower) && webSearch) {
        const q = webSearch[1].trim().replace(/^["']|["']$/g, '').replace(/[.?!]+$/, '');
        const isWiki = /\bwikipedia\b/i.test(lower);
        const explicitOnPageBox = /\bfind\s+(?:the\s+)?search\s*(?:box|bar|field|input)\b/i.test(lower);
        return {
          intent: 'BROWSER_SEARCH',
          fieldHint: 'search',
          onPageOnly: explicitOnPageBox,
          query: q,
          url: isWiki
            ? `https://en.wikipedia.org/w/index.php?search=${encodeURIComponent(q)}`
            : `https://www.google.com/search?q=${encodeURIComponent(q)}`,
          confidence: 0.92,
          summary: `Search browser for "${q}"`,
          rationale: 'Web search intent.'
        };
      }
      // Tab navigation
      if (/\b(?:switch|navigate|go)\s+(?:to\s+)?(?:the\s+)?(.+?\s+)?tab\b|\bnavigate\s+between\s+tabs\b|\blist\s+tabs\b/i.test(lower)) {
        const isList = /\blist\s+tabs\b/i.test(lower);
        const tabMatch = text.match(/(?:switch|go)\s+to\s+(?:the\s+)?(.+?)\s+tab/i);
        return {
          intent: isList ? 'BROWSER_TAB_LIST' : 'BROWSER_TAB_SWITCH',
          query: tabMatch ? tabMatch[1].trim() : '',
          confidence: 0.91,
          summary: isList ? 'List open browser tabs' : `Switch browser tab${tabMatch ? ` to "${tabMatch[1].trim()}"` : ''}`,
          rationale: 'Browser tab navigation intent.'
        };
      }
      // Summarize webpage (routes extracted visible text through local Ollama llama3.2:3b summarizer)
      if (/\b(?:summarize|summary\s+of\s+(?:this|the)\s+(?:webpage|page|article)|overview\s+of\s+(?:this|the)\s+(?:webpage|page|article)|gist\s+of\s+(?:this|the)\s+(?:webpage|page|article)|what\s+is\s+this\s+(?:webpage|page|article)\s+about)\b/i.test(lower)) {
        return {
          intent: 'BROWSER_SUMMARIZE',
          query: text,
          confidence: 0.95,
          summary: 'Summarize current webpage with local AI',
          rationale: 'Browser webpage summarization intent.'
        };
      }
      // Extract webpage info
      if (/\b(?:extract|collect|get\s+(?:the\s+)?(?:page|webpage|visible|heading|title|information|info))\b/i.test(lower)) {
        return {
          intent: 'BROWSER_EXTRACT',
          query: text,
          confidence: 0.93,
          summary: 'Extract visible webpage information',
          rationale: 'Browser extraction intent.'
        };
      }
      // Fill single form field (supports "Fill Name with X", "Fill Name: X", "Set Email to X", "Enter 'X' into Name")
      const fillMatch = text.match(/^(?:please\s+)?fill(?:\s+in|\s+out)?\s+(?:the\s+)?(?:web\s+form\s+|field\s+)?([A-Za-z][A-Za-z0-9 _/-]{0,40}?)\s*(?:\bwith\b|\bas\b|=|:)\s*["']?([^"']+)["']?$/i) ||
                        text.match(/^(?:please\s+)?set\s+(?:the\s+)?(?:field\s+)?([A-Za-z][A-Za-z0-9 _/-]{0,40}?)\s+(?:to|as)\s+["']?([^"']+)["']?$/i) ||
                        text.match(/^(?:please\s+)?(?:enter|type)\s+["']([^"']+)["']\s+(?:into|in)\s+(?:the\s+)?(.+)/i);
      if (fillMatch) {
        const isEnterFirst = /^(?:please\s+)?(?:enter|type)/i.test(text);
        const label = (isEnterFirst ? fillMatch[2] : fillMatch[1]).trim();
        const value = (isEnterFirst ? fillMatch[1] : fillMatch[2]).trim().replace(/[.?!]+$/, '');
        return {
          intent: 'BROWSER_FILL',
          label,
          value,
          confidence: 0.92,
          summary: `Fill "${label}" with "${value}"`,
          rationale: 'Browser form fill intent.'
        };
      }
      // Find & open in-page destination ("Find the contact page and open it", "Open the first relevant result")
      const findAndOpen = text.match(/\bfind\s+(?:the\s+)?(.+?)\s+(?:page|link|section|button)\s+and\s+(?:open|click)\s+it\b/i);
      if (findAndOpen) {
        const label = findAndOpen[1].trim();
        return {
          intent: 'BROWSER_CLICK',
          label,
          confidence: 0.93,
          summary: `Find and open "${label}" link`,
          rationale: 'In-page link discovery and click intent.'
        };
      }
      if (/\bopen\s+(?:the\s+)?first\s+(?:relevant\s+)?result\b/i.test(lower)) {
        return {
          intent: 'BROWSER_CLICK',
          label: '__first_result__',
          confidence: 0.92,
          summary: 'Open first relevant search result',
          rationale: 'Positional search result click intent.'
        };
      }
      // Contextual Click ("Click the Enroll button for Machine Learning Foundations")
      const ctxClickMatch = text.match(/\b(?:click|press|tap|select)\s+(?:the\s+|on\s+)?["']?([A-Za-z0-9 _-]+?)["']?\s+(?:button|link)\s+(?:for|in|under|inside|on)\s+(?:the\s+)?["']?(.+?)["']?[.?!]?$/i);
      if (ctxClickMatch) {
        const label = ctxClickMatch[1].trim();
        const contextHint = ctxClickMatch[2].trim().replace(/\s+(?:card|row|section|panel)$/i, '');
        return {
          intent: 'BROWSER_CLICK',
          label,
          contextHint,
          confidence: 0.94,
          summary: `Click "${label}" in "${contextHint}"`,
          rationale: 'Context-disambiguated browser click intent.'
        };
      }
      // Click / select link, sidebar item, menu option, or button
      const clickMatch = text.match(/\b(?:click|press|tap|select|choose|pick)\s+(?:the\s+|on\s+)?(?:link\s+|button\s+|menu\s+item\s+|sub[- ]?option\s+|option\s+)?["']?(.+?)["']?[.?!]?$/i);
      if (clickMatch) {
        const label = clickMatch[1]
          .trim()
          .replace(/\s+(?:on\s+(?:the\s+)?(?:left|right|top|bottom)(?:\s+(?:side|sidebar|menu|panel))?|in\s+(?:the\s+)?(?:left\s+)?(?:sidebar|menu|nav(?:igation)?|panel|dropdown|popup)|from\s+(?:the\s+)?(?:left\s+)?(?:sidebar|menu|panel|dropdown|popup))(?:\s+of\s+[a-z0-9.]+)?$/i, '')
          .replace(/,?\s+(?:an?\s+|the\s+)?(?:sub[- ]?option|menu\s+option|menu\s+item|link|button|option|tab|item|choice|entry)$/i, '')
          .replace(/[.?!]+$/, '')
          .trim();
        return {
          intent: 'BROWSER_CLICK',
          label,
          confidence: 0.92,
          summary: `Click "${label}" on webpage`,
          rationale: 'Browser DOM click intent.'
        };
      }
      // Open website / URL
      const urlMatch = text.match(/https?:\/\/[^\s]+/i);
      const openSiteMatch = text.match(/\b(?:open|go\s+to|visit|navigate\s+to)\s+(?:the\s+)?(?:website\s+)?([a-z0-9.-]+)/i);
      if (urlMatch || openSiteMatch) {
        let targetUrl = urlMatch ? urlMatch[0].replace(/[.,!?;]+$/, '') : '';
        let siteName = openSiteMatch ? openSiteMatch[1].toLowerCase().replace(/[.,!?;]+$/, '') : targetUrl;
        if (!targetUrl && COMMON_SITES[siteName]) {
          targetUrl = COMMON_SITES[siteName];
        } else if (!targetUrl && /\./.test(siteName) && siteName.length > 3) {
          targetUrl = `https://${siteName}`;
        }
        if (targetUrl) {
          return {
            intent: 'BROWSER_NAVIGATE',
            url: targetUrl,
            label: siteName,
            confidence: 0.94,
            summary: `Open ${siteName} in browser`,
            rationale: 'Direct website navigation intent.'
          };
        }
      }

      return {
        intent: 'BROWSER_EXTRACT',
        query: text,
        confidence: 0.72,
        summary: `Inspect browser page for "${text.slice(0, 50)}"`,
        rationale: context && context.browser && context.browser.url ? 'Active browser page context available.' : 'Default browser inspection.'
      };
    }

    _parseHierarchicalClauses(text) {
      const raw = String(text || '').trim().replace(/[.?!]+$/, '');
      if (!raw) return null;
      // Do not hijack explicit site-open + search or multi-field "Fill X with Y" commands
      if (/^(?:please\s+)?fill\b/i.test(raw) && /\b(?:with|:|=)\b/i.test(raw)) return null;
      if (/\b(?:open|go\s+to|visit)\s+(?:youtube|wikipedia|google|github)\b/i.test(raw) && /\bsearch\b/i.test(raw)) return null;

      const cleanSubOptionLabel = (s) => String(s || '')
        .trim()
        .replace(/^["']|["']$/g, '')
        .replace(/^(?:the\s+|an?\s+)?(?:sub[- ]?option|menu\s+option|menu\s+item|option)\s+(?:called\s+|named\s+)?/i, '')
        .replace(/,?\s+(?:which\s+is\s+)?(?:an?\s+|the\s+)?(?:sub[- ]?option|menu\s+option|menu\s+item|option|item|choice|entry|setting|link|button)$/i, '')
        .trim();

      const cleanParentMenuLabel = (s) => String(s || '')
        .trim()
        .replace(/^["']|["']$/g, '')
        .replace(/\s+(?:on\s+(?:youtube|google|github|this\s+page|the\s+page))$/i, '')
        .replace(/\s+(?:section|panel|menu|submenu|sub-menu|dropdown|popup|popover|group|filter|accordion|list)$/i, '')
        .trim();

      // 0a. Explicit breadcrumb / arrow menu path: "Open Account > Appearance > Dark theme", "Select Account -> YouTube Studio"
      if (/\s*(?:>|->|→|»)\s*/.test(raw)) {
        const strippedPath = raw.replace(/^(?:please\s+)?(?:open|select|choose|pick|click|go\s+to|navigate\s+to)\s+(?:the\s+)?/i, '').trim();
        const segs = strippedPath.split(/\s*(?:>|->|→|»)\s*/).map(cleanSubOptionLabel).filter(Boolean);
        if (segs.length >= 2) {
          const clauses = [];
          for (let i = 0; i < segs.length; i++) {
            const isLeaf = i === segs.length - 1;
            clauses.push({
              actionKind: isLeaf ? 'select' : 'expand',
              targetLabel: isLeaf ? segs[i] : cleanParentMenuLabel(segs[i]),
              parentHint: i > 0 ? cleanParentMenuLabel(segs[i - 1]) : '',
              sectionHint: i > 0 ? cleanParentMenuLabel(segs[i - 1]) : '',
              rawClause: segs[i]
            });
          }
          return {
            isHierarchical: true,
            clauses,
            compareResults: false,
            openBestResult: false,
            summary: `Navigate menu path: ${segs.join(' > ')}`
          };
        }
      }

      // 0b. Parent-first phrasing: "Under Account, select YouTube Studio" / "In the Account menu select Switch account" / "From Account choose YouTube Studio"
      const parentFirstMatch = raw.match(/^(?:under|in|inside|from)\s+(?:the\s+)?["']?(.+?)["']?(?:\s+(?:menu|submenu|dropdown|popup|section|panel))?\s*(?:,\s*|\s+)(?:please\s+)?(?:select|choose|pick|click|open|enable|disable|check|uncheck)\s+(?:the\s+)?["']?(.+?)["']?$/i);
      if (parentFirstMatch) {
        const pHint = cleanParentMenuLabel(parentFirstMatch[1]);
        const tLabel = cleanSubOptionLabel(parentFirstMatch[2]);
        if (pHint && tLabel) {
          return {
            isHierarchical: true,
            clauses: [{
              actionKind: 'select',
              targetLabel: tLabel,
              parentHint: pHint,
              sectionHint: pHint,
              rawClause: raw
            }],
            compareResults: false,
            openBestResult: false,
            summary: `Select "${tLabel}" under "${pHint}"`
          };
        }
      }

      // 0c. Menu Option Discovery: "What options are under Account?", "What are the options in Settings menu?"
      const listMenuOptsMatch = raw.match(/^(?:what|list|show)\s+(?:are\s+)?(?:the\s+)?(?:options|items|settings|choices|sub[- ]?options)\s+(?:are\s+)?(?:available\s+)?(?:under|in|inside|for)\s+(?:the\s+)?["']?(.+?)["']?$/i);
      if (listMenuOptsMatch) {
        const menuName = cleanParentMenuLabel(listMenuOptsMatch[1]);
        if (menuName) {
          return {
            isHierarchical: true,
            clauses: [{
              actionKind: 'list_options',
              targetLabel: menuName,
              parentHint: menuName,
              sectionHint: menuName,
              rawClause: raw
            }],
            compareResults: false,
            openBestResult: false,
            summary: `List menu options under "${menuName}"`
          };
        }
      }

      // 0d. Unscoped Setting / Submenu Commands where user knows NEITHER main menu NOR submenu:
      // e.g. "Switch to Dark theme", "Turn on Dark theme", "Set playback speed to 1.5x", "Change quality to 1080p"
      const unscopedSettingMatch = raw.match(/^(?:please\s+)?(?:switch\s+to|turn\s+on|enable|activate)\s+(?:the\s+)?(dark\s+theme|light\s+theme|device\s+theme|dark\s+mode|light\s+mode|restricted\s+mode|ambient\s+mode|stable\s+volume)$/i) ||
        raw.match(/^(?:please\s+)?(?:set|change)\s+(?:the\s+)?(playback\s+speed|video\s+quality|quality|theme|appearance|language)\s+(?:to\s+|as\s+)?["']?(.+?)["']?$/i);
      if (unscopedSettingMatch) {
        const hasParentCat = Boolean(unscopedSettingMatch[2]);
        const rawTarget = hasParentCat ? cleanSubOptionLabel(unscopedSettingMatch[2]) : cleanSubOptionLabel(unscopedSettingMatch[1]);
        const normalizedTarget = /^dark\s+mode$/i.test(rawTarget) ? 'Dark theme' : (/^light\s+mode$/i.test(rawTarget) ? 'Light theme' : rawTarget);
        return {
          isHierarchical: true,
          clauses: [{
            actionKind: 'select',
            targetLabel: normalizedTarget,
            parentHint: '',
            sectionHint: hasParentCat ? cleanParentMenuLabel(unscopedSettingMatch[1]) : '',
            rawClause: raw
          }],
          compareResults: false,
          openBestResult: false,
          summary: `Find and select "${normalizedTarget}" across menus and submenus`
        };
      }
      // Require at least one clear hierarchical/interactive-control or keyboard+mouse sequence cue
      const hasHierCue = /\b(?:category|submenu|sub-menu|sub[- ]?option|dropdown|accordion|filter\s+(?:for|by)|set\s+(?:the\s+)?(?:price|budget|range|limit|slider|max|min)|below\s+[₹$€£]?\d|under\s+[₹$€£]?\d|expand\s+|collapse\s+|toggle\s+|hover(?:\s+over)?\s+|double[- ]click\s+|right[- ]click\s+|press\s+(?:tab|shift\+tab|enter|escape|space|arrow(?:up|down|left|right))|check\s+|uncheck\s+|(?:select|choose|pick|click|open)\s+.+?\s+(?:under|in|inside|from|for)\s+|\btab\b.*(?:,|and|then)|(?:open|switch\s+to)\s+(?:the\s+)?[a-z0-9 _-]+\s+(?:tab|menu|dropdown|submenu)\b|compare\s+(?:the\s+)?results|open\s+(?:the\s+)?best\s+match|(?:open|click|select|choose|pick|expand)\s+[a-z0-9 _-]+(?:,\s*|\s+(?:and|then)\s+)(?:open|type|click|press|select|choose|pick|check|submit)\b)\b/i.test(raw);
      if (!hasHierCue) return null;

      // Split on commas NOT inside numbers (e.g. preserve ₹70,000), plus " and " / " then "
      const rawParts = raw
        .split(/\s*(?:,(?!\d)\s*(?:and\s+|then\s+)?|\s+and\s+then\s+|\s+then\s+|\s+and\s+(?=(?:open|filter|select|choose|pick|set|expand|collapse|toggle|hover|double[- ]click|right[- ]click|check|uncheck|enable|disable|click|press|type|switch|compare|submit)\b))\s*/i)
        .map((s) => s.trim())
        .filter(Boolean);

      const clauses = [];
      let compareResults = false;
      let openBestResult = false;

      for (const part of rawParts) {
        if (/^compare\s+(?:the\s+|their\s+)?(?:results|items|products|options|listings)/i.test(part)) {
          compareResults = true;
          continue;
        }
        if (/^(?:open|click|select|choose)\s+(?:the\s+)?(?:best(?:\s+matching)?|most\s+relevant|top)\s+(?:match|result|item|product|option)/i.test(part)) {
          openBestResult = true;
          continue;
        }

        // Direct keyboard key press: "press Tab", "press Shift+Tab", "press Enter", "press Escape", "press ArrowDown"
        const keyPressMatch = part.match(/^press\s+(tab|shift\+tab|enter|escape|esc|space|backspace|arrowup|arrowdown|arrowleft|arrowright|up|down|left|right)$/i);
        if (keyPressMatch) {
          clauses.push({
            actionKind: 'press_key',
            targetLabel: keyPressMatch[1].trim(),
            key: keyPressMatch[1].trim(),
            parentHint: '',
            sectionHint: '',
            rawClause: part
          });
          continue;
        }

        // Direct keyboard typing into focused element: "type Ada Lovelace"
        const typeTextMatch = part.match(/^type\s+["']?(.+?)["']?$/i);
        if (typeTextMatch) {
          clauses.push({
            actionKind: 'type_text',
            targetLabel: typeTextMatch[1].trim(),
            textValue: typeTextMatch[1].trim(),
            parentHint: '',
            sectionHint: '',
            rawClause: part
          });
          continue;
        }

        // Direct mouse hover / double-click / right-click
        const mousePrimMatch = part.match(/^(hover(?:\s+over)?|double[- ]click|right[- ]click)\s+(?:on\s+)?(?:the\s+)?(.+)$/i);
        if (mousePrimMatch) {
          const kindRaw = mousePrimMatch[1].toLowerCase();
          const ak = kindRaw.startsWith('hover') ? 'hover' : (kindRaw.startsWith('double') ? 'double_click' : 'right_click');
          clauses.push({
            actionKind: ak,
            targetLabel: mousePrimMatch[2].trim().replace(/\s+(?:menu|button|link|item)$/i, '').trim(),
            parentHint: '',
            sectionHint: '',
            rawClause: part
          });
          continue;
        }

        // Price / numeric threshold: "set the price below ₹70,000", "price under $1,000", "set max price to 70000"
        const threshMatch = part.match(/^(?:set\s+(?:the\s+)?|filter\s+(?:by\s+)?)?(max(?:imum)?\s+|min(?:imum)?\s+)?([a-z][a-z0-9 _-]{1,24}?)\s+(below|under|less\s+than|at\s+most|up\s+to|above|over|at\s+least|to|=)\s+[₹$€£]?\s*([\d,]+(?:\.\d+)?)$/i);
        if (threshMatch) {
          const prefix = (threshMatch[1] || '').trim();
          const fieldName = `${prefix ? `${prefix} ` : ''}${threshMatch[2].trim()}`.trim();
          const opRaw = threshMatch[3].toLowerCase().replace(/\s+/g, '_');
          const numVal = Number(threshMatch[4].replace(/,/g, ''));
          if (Number.isFinite(numVal)) {
            clauses.push({
              actionKind: 'set_threshold',
              targetLabel: fieldName,
              parentHint: fieldName,
              sectionHint: fieldName,
              operator: opRaw,
              numericValue: numVal,
              rawClause: part
            });
            continue;
          }
        }

        // Open category / menu / submenu / tab / accordion: "Open the laptop category", "Open the Specifications tab", "Expand the Warranty accordion"
        const openKindMatch = part.match(/^(?:open|expand|switch\s+to|go\s+to)\s+(?:the\s+)?(.+?)\s+(category|menu|submenu|dropdown|tab|accordion|section|panel)$/i);
        if (openKindMatch) {
          const targetLabel = openKindMatch[1].trim();
          const kind = openKindMatch[2].toLowerCase();
          clauses.push({
            actionKind: kind === 'tab' ? 'tab' : (kind === 'accordion' || kind === 'dropdown' || kind === 'menu' || kind === 'submenu' ? 'expand' : 'open_category'),
            targetLabel,
            parentHint: kind === 'category' ? 'category' : '',
            sectionHint: kind === 'category' ? 'category' : '',
            rawClause: part
          });
          continue;
        }

        // Expand / toggle / collapse without trailing kind noun: "Expand RAM", "Expand Advanced Filters"
        const expandBare = part.match(/^(expand|collapse|toggle)\s+(?:the\s+)?(.+)$/i);
        if (expandBare) {
          clauses.push({
            actionKind: expandBare[1].toLowerCase(),
            targetLabel: expandBare[2].trim(),
            parentHint: '',
            sectionHint: '',
            rawClause: part
          });
          continue;
        }

        // Disambiguated selection: "select 16 GB under RAM", "select YouTube Studio a option under Account", "choose Standard in Shipping"
        const scopedSelect = part.match(/^(?:select|choose|pick|check|uncheck|enable|disable|filter\s+(?:for|by)|click|open)\s+(?:the\s+)?["']?(.+?)["']?\s+(?:under|in|inside|from|for)\s+(?:the\s+)?["']?(.+?)["']?(?:\s+(?:section|panel|menu|submenu|dropdown|popup|group|filter|accordion))?$/i);
        if (scopedSelect) {
          const isUncheck = /^(?:uncheck|disable)\b/i.test(part);
          const cleanedTarget = cleanSubOptionLabel(scopedSelect[1]);
          const cleanedParent = cleanParentMenuLabel(scopedSelect[2]);
          clauses.push({
            actionKind: isUncheck ? 'uncheck' : 'select',
            targetLabel: cleanedTarget || scopedSelect[1].trim(),
            parentHint: cleanedParent || scopedSelect[2].trim(),
            sectionHint: cleanedParent || scopedSelect[2].trim(),
            rawClause: part
          });
          continue;
        }

        // Filter for value + dimension: "filter for 16 GB RAM", "filter by 512 GB SSD"
        const filterDim = part.match(/^filter\s+(?:for|by)\s+(?:the\s+)?(\d+(?:\.\d+)?\s*(?:gb|tb|mb|ghz|hz|inch|in|mp|mah|w))\s+([a-z][a-z0-9 _-]{1,20})$/i);
        if (filterDim) {
          clauses.push({
            actionKind: 'filter',
            targetLabel: filterDim[1].trim(),
            parentHint: filterDim[2].trim(),
            sectionHint: filterDim[2].trim(),
            rawClause: part
          });
          continue;
        }

        // Generic filter: "filter for 16 GB" or "filter by Dell"
        const filterBare = part.match(/^filter\s+(?:for|by)\s+(?:the\s+)?(.+)$/i);
        if (filterBare) {
          clauses.push({
            actionKind: 'filter',
            targetLabel: filterBare[1].trim(),
            parentHint: '',
            sectionHint: '',
            rawClause: part
          });
          continue;
        }

        // Select / choose / check / uncheck / click / open / submit bare control in multi-step chain:
        // If "open Account" precedes another clause ("Open Account and select YouTube Studio"), mark it as 'expand' so it opens the menu cleanly!
        const bareSelect = part.match(/^(select|choose|pick|check|uncheck|enable|disable|click|press|open|submit)\s*(?:the\s+)?(.*)$/i);
        if (bareSelect) {
          const verb = bareSelect[1].toLowerCase();
          const rest = cleanSubOptionLabel(
            (bareSelect[2] || '')
              .trim()
              .replace(/\s+(?:on\s+(?:the\s+)?(?:left|right|top|bottom)(?:\s+(?:side|sidebar|menu|panel))?|in\s+(?:the\s+)?(?:left\s+)?(?:sidebar|menu|nav(?:igation)?|panel)|from\s+(?:the\s+)?(?:left\s+)?(?:sidebar|menu|panel))(?:\s+of\s+[a-z0-9.]+)?$/i, '')
          );
          const label = rest || (verb === 'submit' ? 'Submit' : '');
          const hasSubsequentStep = rawParts.indexOf(part) < rawParts.length - 1;
          if (label) {
            const computedKind = verb === 'uncheck' || verb === 'disable'
              ? 'uncheck'
              : (verb === 'open' && hasSubsequentStep
                  ? 'expand'
                  : (verb === 'click' || verb === 'press' || verb === 'submit' ? 'click' : 'select'));
            clauses.push({
              actionKind: computedKind,
              targetLabel: computedKind === 'expand' ? cleanParentMenuLabel(label) : label,
              parentHint: '',
              sectionHint: '',
              rawClause: part
            });
          }
        }
      }

      if (clauses.length === 0) return null;
      // Avoid overriding simple single-step "switch to X tab" browser tab switching when there is only 1 tab clause and no in-page controls
      if (clauses.length === 1 && clauses[0].actionKind === 'tab' && !compareResults && !openBestResult && /\bswitch\s+to\b/i.test(raw) && !/\baccordion|filter|select|check|category|section\b/i.test(raw)) {
        // Still allow in-page ARIA tab if explicitly named like "Open the Specifications tab"
        if (!/^open\s+/i.test(raw)) return null;
      }

      return {
        isHierarchical: true,
        clauses,
        compareResults,
        openBestResult,
        summary: `Execute ${clauses.length} hierarchical webpage control step${clauses.length === 1 ? '' : 's'}${compareResults ? ', compare results' : ''}${openBestResult ? ', and open best match' : ''}`
      };
    }

    /**
     * Gather targeted, non-blocking context from browser page, tabs, active desktop window,
     * and top-K Nomic semantic memory (NEVER dumps full history!).
     */
    async gatherRelevantContext(rawText, routing, signal = null) {
      const ctx = {
        timestamp: new Date().toISOString(),
        browser: null,
        desktop: null,
        relevantMemories: [],
        embedModel: 'none',
        usedNomicEmbeddings: false
      };

      const tasks = [];

      // Browser context (live DOM/page state)
      tasks.push(
        this.browserBackend.probeState({ action: 'observe' })
          .then((state) => {
            if (state && typeof state === 'object') {
              ctx.browser = {
                url: state.url || '',
                title: state.title || '',
                readyState: state.readyState || '',
                headings: Array.isArray(state.headings) ? state.headings.slice(0, 5) : []
              };
            }
          })
          .catch(() => {})
      );

      // Desktop window context (only poll when desktop or cross_backend, bounded non-blocking)
      if (routing.route === 'desktop' || routing.route === 'cross_backend' || routing.route === 'clarification') {
        tasks.push(
          this.desktopBackend.queryActiveWindow(signal)
            .then((win) => {
              if (win && win.hwnd) {
                ctx.desktop = {
                  activeWindow: {
                    hwnd: win.hwnd,
                    processId: win.processId,
                    processName: win.processName,
                    title: win.title
                  }
                };
              }
            })
            .catch(() => {
              ctx.desktop = { activeWindow: null, available: false };
            })
        );
      }

      // Targeted Nomic semantic memory retrieval (top-K = 3 only!)
      tasks.push(
        this.memoryBridge.retrieveRelevant(rawText, { topK: 3, timeoutMs: 1000 })
          .then((mem) => {
            ctx.relevantMemories = mem.items || [];
            ctx.embedModel = mem.embedModel || 'none';
            ctx.usedNomicEmbeddings = Boolean(mem.usedNomic);
          })
          .catch(() => {})
      );

      await Promise.all(tasks);
      return ctx;
    }

    /**
     * Single Central Planning Authority (Sections 1 & 7).
     * Creates ordered, atomic, verifiable steps with explicit cross-backend data bindings.
     */
    buildPlan(rawText, routing, context = {}, options = {}) {
      const steps = [];
      let idx = 0;
      const pushStep = (spec) => {
        idx += 1;
        steps.push({
          stepIndex: idx,
          stepId: `step-${idx}-${spec.backend}-${spec.action}`,
          label: spec.label,
          backend: spec.backend,
          action: spec.action,
          target: spec.target || {},
          parameters: spec.parameters || {},
          expectedState: spec.expectedState || null,
          timeout: spec.timeout || 10000,
          idempotent: spec.idempotent !== false,
          retryable: spec.retryable !== false,
          outputKey: spec.outputKey || null,
          bindFromKey: spec.bindFromKey || null,
          bindTransform: spec.bindTransform || null
        });
      };

      if (routing.route === 'cross_backend' && routing.direction === 'browser_to_desktop') {
        const app = routing.desktopApp || DESKTOP_APP_CATALOG[0];
        const queryMatch = rawText.match(/(?:search\s+(?:the\s+web\s+|online\s+)?for\s+|collect\s+|extract\s+|find\s+)(.+?)(?:\s+and\s+(?:write|save|put|type|paste)|$)/i);
        const query = queryMatch ? queryMatch[1].trim() : 'latest Python release';
        const curBrowserUrl = String((context && context.browser && context.browser.url) || '');
        const alreadyOnMatchingTopicPage = (/python\s+release|latest\s+python/i.test(query) && /python/i.test(curBrowserUrl));
        const needsSearch = !alreadyOnMatchingTopicPage && /\b(?:search|open|visit)\b/i.test(rawText) && !/\b(?:from\s+this\s+page|current\s+page|this\s+webpage)\b/i.test(rawText);

        if (needsSearch) {
          const targetUrl = options.crossSearchUrl ||
            (/python\s+release|latest\s+python/i.test(query)
              ? 'https://www.python.org/downloads/'
              : `https://en.wikipedia.org/w/index.php?search=${encodeURIComponent(query)}`);
          pushStep({
            label: `Retrieve web page for "${query}"`,
            backend: 'browser',
            action: 'navigate',
            target: { url: targetUrl, label: query },
            parameters: { query },
            expectedState: { navigationComplete: true },
            timeout: 12000,
            idempotent: true,
            retryable: true
          });
        }

        pushStep({
          label: `Extract verified information ("${query}") from browser`,
          backend: 'browser',
          action: 'extract',
          target: { label: query },
          parameters: { query },
          expectedState: { extractedNonEmpty: true },
          timeout: 8000,
          idempotent: true,
          retryable: true,
          outputKey: 'extractedInfo'
        });

        pushStep({
          label: `Launch and focus ${app.name}`,
          backend: 'desktop',
          action: 'launch_app',
          target: { text: app.executable, processName: app.processName },
          parameters: { executable: app.executable },
          expectedState: { mustBeForeground: true, foregroundProcess: app.processName },
          timeout: 10000,
          idempotent: true,
          retryable: true,
          outputKey: 'desktopWindow'
        });

        if (app.name === 'Notepad') {
          pushStep({
            label: 'Focus Notepad document editor',
            backend: 'desktop',
            action: 'ensure_notepad_editor',
            target: { processName: 'Notepad' },
            expectedState: { foregroundProcess: 'Notepad' },
            timeout: 4000,
            idempotent: true,
            retryable: true
          });
        }

        pushStep({
          label: `Type verified web info into ${app.name} and verify readback`,
          backend: 'desktop',
          action: 'type_text',
          target: { processName: app.processName, delayMs: 10, verifyInput: true },
          parameters: { delayMs: 10, verifyInput: true },
          bindFromKey: 'extractedInfo',
          expectedState: {
            mustBeForeground: true,
            foregroundProcess: app.processName,
            requireReceiptVerified: true,
            forceLiveReadback: true
          },
          timeout: 12000,
          idempotent: false,
          retryable: false
        });

        if (app.name === 'Notepad' && (/\bsave\b.+\b(?:file|local\s+file|documents)\b/i.test(rawText) || options.saveFilePath)) {
          const targetSavePath = options.saveFilePath || 'Sleepwalker_Web_Info.txt';
          pushStep({
            label: 'Open Save As dialog (Ctrl+Shift+S)',
            backend: 'desktop',
            action: 'key_combination',
            target: { modifiers: ['Ctrl', 'Shift'], key: 'S', processName: 'Notepad' },
            timeout: 5000,
            idempotent: false,
            retryable: false
          });
          pushStep({
            label: 'Select existing File name field in Save As dialog',
            backend: 'desktop',
            action: 'key_combination',
            target: { modifiers: ['Ctrl'], key: 'A', allowUnexpectedDialogs: true, titleContains: 'Save' },
            parameters: { delayBeforeMs: 750 },
            timeout: 5000,
            idempotent: false,
            retryable: false
          });
          pushStep({
            label: 'Enter local destination path in Save As dialog',
            backend: 'desktop',
            action: 'type_text',
            target: { text: targetSavePath, delayMs: 8, verifyInput: false, allowUnexpectedDialogs: true, titleContains: 'Save' },
            parameters: { delayBeforeMs: 100 },
            timeout: 8000,
            idempotent: false,
            retryable: false
          });
          pushStep({
            label: 'Invoke Save button via UI Automation',
            backend: 'desktop',
            action: 'uia_invoke',
            target: { automationId: '1', controlType: 'Button', titleContains: 'Save', maxDepth: 3 },
            parameters: { delayBeforeMs: 150 },
            timeout: 8000,
            idempotent: false,
            retryable: false
          });
        }
      } else if (routing.route === 'cross_backend' && routing.direction === 'desktop_to_browser') {
        const app = routing.desktopApp || DESKTOP_APP_CATALOG[0];
        const isWiki = /\bwikipedia\b/i.test(rawText);
        const isYt = /\byoutube\b/i.test(rawText);

        pushStep({
          label: `Read verified text from ${app.name} via UI Automation`,
          backend: 'desktop',
          action: 'uia_read_text',
          target: { processName: app.processName },
          expectedState: { foregroundProcess: app.processName },
          timeout: 6000,
          idempotent: true,
          retryable: true,
          outputKey: 'desktopText'
        });

        pushStep({
          label: 'Search browser using verified desktop text',
          backend: 'browser',
          action: 'search',
          target: { label: 'search' },
          parameters: {
            searchUrlTemplate: options.desktopToBrowserSearchTemplate || (
              isYt
                ? 'https://www.youtube.com/results?search_query={query}'
                : (isWiki
                  ? 'https://en.wikipedia.org/w/index.php?search={query}'
                  : 'https://www.google.com/search?q={query}')
            )
          },
          bindFromKey: 'desktopText',
          expectedState: { navigationComplete: true },
          timeout: 12000,
          idempotent: true,
          retryable: true
        });
      } else if (routing.route === 'desktop') {
        const sub = routing.subDetails || {};
        const app = routing.desktopApp || sub.desktopApp || DESKTOP_APP_CATALOG[0];

        if (sub.intent === 'DESKTOP_CALCULATE') {
          const digitNames = { '0': 'Zero', '1': 'One', '2': 'Two', '3': 'Three', '4': 'Four', '5': 'Five', '6': 'Six', '7': 'Seven', '8': 'Eight', '9': 'Nine' };
          const opMap = { '+': 'Plus', '-': 'Minus', '*': 'Multiply by', 'x': 'Multiply by', '×': 'Multiply by', '/': 'Divide by' };
          const expectedResult = (() => {
            const a = Number(sub.a); const b = Number(sub.b);
            if (sub.op === '+') return String(a + b);
            if (sub.op === '-') return String(a - b);
            if (sub.op === '*' || sub.op === 'x' || sub.op === '×') return String(a * b);
            if (sub.op === '/' && b !== 0) return String(a / b);
            return '';
          })();

          pushStep({
            label: 'Launch Windows Calculator',
            backend: 'desktop',
            action: 'launch_app',
            target: { text: 'calc.exe', processName: 'Calculator', titleContains: 'Calculator' },
            expectedState: { mustBeForeground: true, foregroundTitleContains: 'Calculator' },
            timeout: 12000,
            idempotent: true,
            retryable: true
          });
          pushStep({
            label: 'Clear Calculator display',
            backend: 'desktop',
            action: 'uia_invoke',
            target: { automationId: 'clearButton', processName: 'Calculator' },
            timeout: 5000,
            idempotent: true,
            retryable: true
          });
          for (const ch of String(sub.a)) {
            if (digitNames[ch]) {
              pushStep({ label: `Press ${digitNames[ch]}`, backend: 'desktop', action: 'uia_invoke', target: { name: digitNames[ch], controlType: 'Button', processName: 'Calculator' }, timeout: 5000, idempotent: false, retryable: false });
            }
          }
          pushStep({ label: `Press ${opMap[sub.op] || 'Plus'}`, backend: 'desktop', action: 'uia_invoke', target: { name: opMap[sub.op] || 'Plus', controlType: 'Button', processName: 'Calculator' }, timeout: 5000, idempotent: false, retryable: false });
          for (const ch of String(sub.b)) {
            if (digitNames[ch]) {
              pushStep({ label: `Press ${digitNames[ch]}`, backend: 'desktop', action: 'uia_invoke', target: { name: digitNames[ch], controlType: 'Button', processName: 'Calculator' }, timeout: 5000, idempotent: false, retryable: false });
            }
          }
          pushStep({
            label: 'Press Equals and verify calculation result',
            backend: 'desktop',
            action: 'uia_invoke',
            target: { name: 'Equals', controlType: 'Button', processName: 'Calculator' },
            expectedState: expectedResult ? { uiaTextContains: expectedResult, forceLiveReadback: true, uiaReadTarget: { automationId: 'CalculatorResults' } } : null,
            timeout: 5000,
            idempotent: false,
            retryable: false
          });
        } else if (sub.intent === 'DESKTOP_LAUNCH_AND_TYPE') {
          pushStep({
            label: `Launch and focus ${app.name}`,
            backend: 'desktop',
            action: 'launch_app',
            target: { text: app.executable, processName: app.processName },
            expectedState: { mustBeForeground: true, foregroundProcess: app.processName },
            timeout: 10000,
            idempotent: true,
            retryable: true,
            outputKey: 'desktopWindow'
          });
          if (app.name === 'Notepad') {
            pushStep({
              label: 'Focus Notepad editor',
              backend: 'desktop',
              action: 'ensure_notepad_editor',
              target: { processName: 'Notepad' },
              timeout: 4000,
              idempotent: true,
              retryable: true
            });
          }
          pushStep({
            label: `Type "${sub.textToType.slice(0, 36)}" into ${app.name}`,
            backend: 'desktop',
            action: 'type_text',
            target: { text: sub.textToType, processName: app.processName, delayMs: 10, verifyInput: true },
            expectedState: {
              mustBeForeground: true,
              foregroundProcess: app.processName,
              requireReceiptVerified: true,
              uiaTextContains: sub.textToType,
              forceLiveReadback: true
            },
            timeout: 12000,
            idempotent: false,
            retryable: false
          });
        } else if (sub.intent === 'DESKTOP_ACTIVATE_WINDOW') {
          pushStep({
            label: `Switch to ${app.name} and verify foreground`,
            backend: 'desktop',
            action: 'activate_window',
            target: { processName: app.processName, titleContains: app.titleContains },
            expectedState: { mustBeForeground: true, foregroundProcess: app.processName },
            timeout: 6000,
            idempotent: true,
            retryable: true
          });
        } else if (sub.intent === 'DESKTOP_TYPE_ACTIVE') {
          pushStep({
            label: `Focus ${app.name} editor`,
            backend: 'desktop',
            action: 'activate_window',
            target: { processName: app.processName },
            expectedState: { mustBeForeground: true, foregroundProcess: app.processName },
            timeout: 6000,
            idempotent: true,
            retryable: true
          });
          if (app.name === 'Notepad') {
            pushStep({
              label: 'Ensure Notepad editor focused',
              backend: 'desktop',
              action: 'ensure_notepad_editor',
              target: { processName: 'Notepad' },
              timeout: 4000,
              idempotent: true,
              retryable: true
            });
          }
          pushStep({
            label: `Write note into ${app.name}`,
            backend: 'desktop',
            action: 'type_text',
            target: { text: sub.textToType, processName: app.processName, delayMs: 10, verifyInput: true },
            expectedState: { mustBeForeground: true, foregroundProcess: app.processName, requireReceiptVerified: true, uiaTextContains: sub.textToType, forceLiveReadback: true },
            timeout: 12000,
            idempotent: false,
            retryable: false
          });
        } else if (sub.intent === 'DESKTOP_SAVE_DIALOG') {
          const targetSavePath = options.saveFilePath || sub.savePath || 'Sleepwalker_Stage5_Note.txt';
          pushStep({
            label: `Focus ${app.name} before saving`,
            backend: 'desktop',
            action: 'activate_window',
            target: { processName: app.processName },
            expectedState: { mustBeForeground: true, foregroundProcess: app.processName },
            timeout: 6000,
            idempotent: true,
            retryable: true
          });
          pushStep({
            label: 'Open Save As dialog (Ctrl+Shift+S)',
            backend: 'desktop',
            action: 'key_combination',
            target: { modifiers: ['Ctrl', 'Shift'], key: 'S', processName: app.processName },
            timeout: 5000,
            idempotent: false,
            retryable: false
          });
          pushStep({
            label: 'Select existing File name field in Save As dialog',
            backend: 'desktop',
            action: 'key_combination',
            target: { modifiers: ['Ctrl'], key: 'A', allowUnexpectedDialogs: true, titleContains: 'Save' },
            parameters: { delayBeforeMs: 750 },
            timeout: 5000,
            idempotent: false,
            retryable: false
          });
          pushStep({
            label: 'Enter destination path in Save As dialog',
            backend: 'desktop',
            action: 'type_text',
            target: { text: targetSavePath, delayMs: 8, verifyInput: false, allowUnexpectedDialogs: true, titleContains: 'Save' },
            parameters: { delayBeforeMs: 100 },
            timeout: 8000,
            idempotent: false,
            retryable: false
          });
          pushStep({
            label: 'Invoke Save button via UI Automation',
            backend: 'desktop',
            action: 'uia_invoke',
            target: { automationId: '1', controlType: 'Button', titleContains: 'Save', maxDepth: 3 },
            parameters: { delayBeforeMs: 150 },
            timeout: 8000,
            idempotent: false,
            retryable: false
          });
        } else if (sub.intent === 'DESKTOP_READ_TEXT') {
          pushStep({
            label: `Read text from ${app.name} via UI Automation`,
            backend: 'desktop',
            action: 'uia_read_text',
            target: { processName: app.processName },
            timeout: 6000,
            idempotent: true,
            retryable: true,
            outputKey: 'desktopText'
          });
        } else {
          pushStep({
            label: `Launch and verify ${app.name}`,
            backend: 'desktop',
            action: 'launch_app',
            target: { text: app.executable, processName: app.processName, titleContains: app.titleContains },
            expectedState: { mustBeForeground: true, foregroundProcess: app.processName },
            timeout: 10000,
            idempotent: true,
            retryable: true
          });
        }
      } else if (routing.route === 'browser') {
        const sub = routing.subDetails || {};
        if (sub.intent === 'BROWSER_SEARCH_AND_SELECT') {
          const curUrl = String((context && context.browser && context.browser.url) || '').toLowerCase();
          let targetHost = '';
          if (sub.siteUrl) {
            try { targetHost = new URL(sub.siteUrl).hostname.replace(/^www\./, '').toLowerCase(); } catch (_e) {}
          }
          const alreadyOnTargetHost = Boolean(targetHost && curUrl.includes(targetHost));

          if (sub.siteUrl && !alreadyOnTargetHost) {
            pushStep({
              label: `Open ${sub.site} in Chromium`,
              backend: 'browser',
              action: 'navigate',
              target: { url: sub.siteUrl, label: sub.site },
              expectedState: targetHost ? { urlContains: targetHost, navigationComplete: true } : { navigationComplete: true },
              timeout: 15000,
              idempotent: true,
              retryable: true
            });
          }

          pushStep({
            label: `Inspect active ${sub.site === 'current' ? 'page' : sub.site} DOM and identify search input`,
            backend: 'browser',
            action: 'observe',
            target: { label: sub.fieldHint || 'search' },
            parameters: { query: sub.fieldHint || 'search input' },
            timeout: 10000,
            idempotent: true,
            retryable: true,
            outputKey: 'observedPageState'
          });

          pushStep({
            label: `Enter "${sub.query}" into search field and submit`,
            backend: 'browser',
            action: 'search',
            target: { label: sub.fieldHint || 'search' },
            parameters: { query: sub.query, submitAfterFill: true },
            expectedState: sub.site === 'youtube'
              ? { urlContains: 'search_query', navigationComplete: true }
              : { navigationComplete: true },
            timeout: 18000,
            idempotent: true,
            retryable: true
          });

          if (sub.compareResults || sub.inspectCount > 0) {
            pushStep({
              label: `Inspect first ${sub.inspectCount || 5} results and compare titles & descriptions`,
              backend: 'browser',
              action: 'extract',
              target: { label: 'search_results' },
              parameters: {
                extractMode: 'search_results',
                maxResults: sub.inspectCount || 5,
                query: sub.query,
                compareResultsWithLocalAi: true,
                userRequest: rawText
              },
              expectedState: { minResultsCount: 1 },
              timeout: 18000,
              idempotent: true,
              retryable: true,
              outputKey: 'searchResults'
            });
          }

          if (sub.openBestResult) {
            pushStep({
              label: 'Open the most relevant result and verify destination page',
              backend: 'browser',
              action: 'click',
              target: { label: '__first_result__' },
              bindFromKey: 'selectedResult',
              expectedState: sub.site === 'youtube'
                ? { urlContains: '/watch', navigationComplete: true }
                : { navigationComplete: true },
              timeout: 16000,
              idempotent: false,
              retryable: true,
              outputKey: 'openedResultPage'
            });
          }
        } else if (sub.intent === 'BROWSER_HIERARCHICAL_WORKFLOW') {
          pushStep({
            label: 'Inspect interactive page hierarchy and controls',
            backend: 'browser',
            action: 'observe',
            target: { label: 'interactive controls' },
            parameters: { query: 'interactive hierarchy' },
            timeout: 8000,
            idempotent: true,
            retryable: true,
            outputKey: 'observedPageState'
          });

          for (const cl of (sub.clauses || [])) {
            if (cl.actionKind === 'press_key') {
              pushStep({
                label: `Press ${cl.key} key via CDP keyboard`,
                backend: 'browser',
                action: 'press_key',
                target: { key: cl.key },
                parameters: { key: cl.key },
                timeout: 6000,
                idempotent: false,
                retryable: false
              });
              continue;
            }
            if (cl.actionKind === 'type_text') {
              pushStep({
                label: `Type "${cl.textValue}" via CDP keyboard`,
                backend: 'browser',
                action: 'type_text',
                target: {},
                parameters: { text: cl.textValue },
                timeout: 8000,
                idempotent: false,
                retryable: false
              });
              continue;
            }
            if (cl.actionKind === 'hover' || cl.actionKind === 'double_click' || cl.actionKind === 'right_click') {
              pushStep({
                label: `${cl.actionKind.replace('_', ' ')} "${cl.targetLabel}" via CDP mouse`,
                backend: 'browser',
                action: cl.actionKind,
                target: { label: cl.targetLabel },
                timeout: 8000,
                idempotent: true,
                retryable: true
              });
              continue;
            }
            const desc = cl.actionKind === 'set_threshold'
              ? `Set ${cl.targetLabel} ${cl.operator || 'to'} ${cl.numericValue}`
              : `${cl.actionKind === 'expand' ? 'Expand' : (cl.actionKind === 'open_category' ? 'Open' : 'Select')} "${cl.targetLabel}"${cl.parentHint ? ` (${cl.parentHint})` : ''}`;
            pushStep({
              label: desc,
              backend: 'browser',
              action: 'interact_control',
              target: {
                label: cl.targetLabel,
                parentHint: cl.parentHint || '',
                sectionHint: cl.sectionHint || cl.parentHint || ''
              },
              parameters: {
                actionKind: cl.actionKind,
                numericValue: cl.numericValue,
                operator: cl.operator || ''
              },
              expectedState: { controlVerified: true },
              timeout: 12000,
              idempotent: true,
              retryable: true,
              outputKey: cl.actionKind === 'list_options' ? 'extractedInfo' : 'lastControlResult'
            });
          }

          if (sub.compareResults) {
            pushStep({
              label: 'Inspect filtered results and compare matches with local AI',
              backend: 'browser',
              action: 'extract',
              target: { label: 'search_results' },
              parameters: {
                extractMode: 'search_results',
                maxResults: 5,
                query: rawText,
                compareResultsWithLocalAi: true,
                userRequest: rawText
              },
              expectedState: { minResultsCount: 1 },
              timeout: 16000,
              idempotent: true,
              retryable: true,
              outputKey: 'searchResults'
            });
          }

          if (sub.openBestResult) {
            pushStep({
              label: 'Open the best matching result and verify destination view',
              backend: 'browser',
              action: 'click',
              target: { label: '__first_result__' },
              bindFromKey: 'selectedResult',
              expectedState: { navigationComplete: true },
              timeout: 14000,
              idempotent: false,
              retryable: true,
              outputKey: 'openedResultPage'
            });
          }
        } else if (sub.intent === 'BROWSER_FORM_FILL_SUBMIT') {
          for (const f of (sub.fields || [])) {
            pushStep({
              label: `Fill "${f.label}" with "${f.value}"`,
              backend: 'browser',
              action: 'fill',
              target: { label: f.label },
              parameters: { value: f.value },
              expectedState: { valueEquals: f.value },
              timeout: 10000,
              idempotent: true,
              retryable: true
            });
          }
          if (sub.submit) {
            pushStep({
              label: `Submit form via "${sub.submitLabel || 'Submit'}"`,
              backend: 'browser',
              action: 'click',
              target: { label: sub.submitLabel || 'Submit' },
              expectedState: { navigationComplete: true },
              timeout: 12000,
              idempotent: false,
              retryable: true
            });
          }
        } else if (sub.intent === 'BROWSER_SCROLL_AND_ACT') {
          pushStep({
            label: `Scroll to "${sub.scrollTarget}"`,
            backend: 'browser',
            action: 'scroll',
            target: { label: sub.scrollTarget },
            parameters: { direction: /^(?:up|top)$/i.test(sub.scrollTarget) ? 'up' : 'down', deltaY: 550 },
            expectedState: { scrollChanged: true },
            timeout: 8000,
            idempotent: true,
            retryable: true
          });
          if (sub.nextAction === 'extract') {
            pushStep({
              label: `Inspect "${sub.actionTarget}"`,
              backend: 'browser',
              action: 'extract',
              target: { label: sub.actionTarget },
              parameters: { query: sub.actionTarget },
              expectedState: { extractedNonEmpty: true },
              timeout: 10000,
              idempotent: true,
              retryable: true,
              outputKey: 'extractedInfo'
            });
          } else {
            pushStep({
              label: `Click "${sub.actionTarget}"`,
              backend: 'browser',
              action: 'click',
              target: { label: sub.actionTarget, contextHint: sub.scrollTarget !== 'down' && sub.scrollTarget !== 'up' ? sub.scrollTarget : '' },
              timeout: 10000,
              idempotent: false,
              retryable: true
            });
          }
        } else if (sub.intent === 'BROWSER_SEARCH_SITE' || sub.intent === 'BROWSER_NAVIGATE') {
          let host = '';
          try { host = new URL(sub.url).hostname.replace(/^www\./, ''); } catch (_e) {}
          pushStep({
            label: sub.summary || `Navigate to ${sub.url}`,
            backend: 'browser',
            action: 'navigate',
            target: { url: sub.url, label: sub.label || sub.site || sub.query },
            parameters: { query: sub.query || '' },
            expectedState: host ? { urlContains: host, navigationComplete: true } : { navigationComplete: true },
            timeout: 12000,
            idempotent: true,
            retryable: true
          });
        } else if (sub.intent === 'BROWSER_SEARCH') {
          pushStep({
            label: sub.summary,
            backend: 'browser',
            action: 'search',
            target: { label: sub.fieldHint || 'search' },
            parameters: {
              query: sub.query,
              searchUrlTemplate: (!sub.onPageOnly && sub.url) ? sub.url.replace(encodeURIComponent(sub.query), '{query}') : undefined
            },
            expectedState: { domTextContains: sub.query },
            timeout: 12000,
            idempotent: true,
            retryable: true
          });
        } else if (sub.intent === 'BROWSER_CLICK') {
          pushStep({
            label: sub.summary,
            backend: 'browser',
            action: 'click',
            target: { label: sub.label, contextHint: sub.contextHint || '' },
            expectedState: sub.label === '__first_result__' ? null : { accessibleName: sub.label },
            timeout: 10000,
            idempotent: false,
            retryable: true
          });
        } else if (sub.intent === 'BROWSER_FILL') {
          pushStep({
            label: sub.summary,
            backend: 'browser',
            action: 'fill',
            target: { label: sub.label },
            parameters: { value: sub.value },
            expectedState: { valueEquals: sub.value },
            timeout: 10000,
            idempotent: true,
            retryable: true
          });
        } else if (sub.intent === 'BROWSER_TAB_LIST' || sub.intent === 'BROWSER_TAB_SWITCH') {
          pushStep({
            label: sub.summary,
            backend: 'browser',
            action: sub.intent === 'BROWSER_TAB_LIST' ? 'tab_list' : 'tab_switch',
            target: { label: sub.query || '' },
            timeout: 5000,
            idempotent: true,
            retryable: true
          });
        } else if (sub.intent === 'BROWSER_SUMMARIZE') {
          pushStep({
            label: sub.summary || 'Summarize current webpage with local AI',
            backend: 'browser',
            action: 'extract',
            target: { label: sub.query || '' },
            parameters: { query: sub.query || rawText, summarizeWithLocalAi: true },
            expectedState: { extractedNonEmpty: true },
            timeout: 12000,
            idempotent: true,
            retryable: true,
            outputKey: 'extractedInfo'
          });
        } else {
          pushStep({
            label: sub.summary || 'Extract visible webpage info',
            backend: 'browser',
            action: 'extract',
            target: { label: sub.query || '' },
            parameters: { query: sub.query || rawText },
            expectedState: { extractedNonEmpty: true },
            timeout: 10000,
            idempotent: true,
            retryable: true,
            outputKey: 'extractedInfo'
          });
        }
      }

      if (options.inBrowserTab && steps.length > 0) {
        for (let si = 0; si < steps.length; si++) {
          if (steps[si].backend === 'browser' && ['navigate', 'search', 'click'].includes(steps[si].action)) {
            steps[si].parameters = { ...(steps[si].parameters || {}), awaitDocumentUnload: true };
          }
        }
      }

      return {
        planId: generateId('plan'),
        route: routing.route,
        direction: routing.direction,
        intent: routing.intent,
        understoodSummary: routing.understoodSummary,
        steps
      };
    }

    /**
     * Single unified cancellation mechanism (Sections 1 & 8).
     * Immediately aborts the active AbortController and propagates cancel to BOTH backends.
     */
    async cancelActiveCommand(reason = 'Cancelled by user') {
      const cmdId = this.activeCommandId;
      const taskId = this.activeTaskId;
      if (!cmdId) {
        return { ok: true, status: 'IDLE', cancelled: false, message: 'No active command to cancel' };
      }

      const abortCtrl = this.activeAbortController;
      this.lifecycle.markCancelled(cmdId, taskId, reason);

      if (abortCtrl && !abortCtrl.signal.aborted) {
        try { abortCtrl.abort(reason); } catch (_e) {}
      }

      const [browserCancel, desktopCancel] = await Promise.all([
        this.browserBackend.cancel(cmdId, taskId).catch((e) => ({ ok: false, error: String(e) })),
        this.desktopBackend.cancel(cmdId, taskId).catch((e) => ({ ok: false, error: String(e) }))
      ]);

      return {
        ok: true,
        cancelled: true,
        status: LIFECYCLE_STATES.CANCELLED,
        commandId: cmdId,
        taskId,
        reason,
        propagated: {
          browser: browserCancel,
          desktop: desktopCancel
        }
      };
    }

    /**
     * Main Unified Orchestrator entry point.
     * Runs the complete lifecycle:
     * IDLE -> (LISTENING) -> UNDERSTANDING -> GATHERING_CONTEXT -> PLANNING
     * -> [RESOLVING_TARGET -> EXECUTING -> VERIFYING (or RECOVERING)]* -> COMPLETED | FAILED | CANCELLED | TIMEOUT | WAITING_FOR_USER
     */
    async executeCommand(rawText, options = {}) {
      const text = String(rawText || '').trim();
      const inputSource = options.inputSource || 'typed';
      const overallTimeoutMs = Number(options.timeoutMs || this.defaultTimeoutMs);

      // Preempt any previous in-flight command cleanly before starting the new command
      if (this.activeCommandId && !TERMINAL_STATES.has(this.lifecycle.state) && this.lifecycle.state !== LIFECYCLE_STATES.IDLE) {
        await this.cancelActiveCommand('preempted_by_newer_command');
      }

      const ids = this.lifecycle.beginCommand({
        taskId: options.taskId,
        commandId: options.commandId,
        rawText: text,
        inputSource,
        startListening: inputSource === 'voice'
      });
      const { taskId, commandId } = ids;

      const abortCtrl = typeof AbortController === 'function' ? new AbortController() : null;
      this.activeAbortController = abortCtrl;
      this.activeCommandId = commandId;
      this.activeTaskId = taskId;

      let globalTimer = null;
      let timedOut = false;
      if (abortCtrl && overallTimeoutMs > 0) {
        globalTimer = setTimeout(() => {
          timedOut = true;
          try { abortCtrl.abort('command_timeout'); } catch (_e) {}
        }, overallTimeoutMs);
      }

      const completedSteps = Array.isArray(options.initialCompletedSteps)
        ? options.initialCompletedSteps.slice()
        : [];
      const priorStepCount = completedSteps.length;
      const stepResults = [];
      const sharedArtifacts = (options.initialSharedArtifacts && typeof options.initialSharedArtifacts === 'object')
        ? { ...options.initialSharedArtifacts }
        : {}; // verified data passed between steps (e.g., extractedInfo, desktopText, desktopWindow)

      const buildFinalEnvelope = (terminalState, extras = {}) => {
        const record = this.lifecycle.getCommandRecord(commandId);
        const envelope = {
          taskId,
          commandId,
          rawText: text,
          ok: terminalState === LIFECYCLE_STATES.COMPLETED,
          status: terminalState,
          route: extras.route || 'none',
          intent: extras.intent || null,
          understoodSummary: extras.understoodSummary || text,
          contextUsed: extras.contextUsed || null,
          plan: extras.plan || null,
          completedSteps: completedSteps.slice(),
          incompleteSteps: extras.incompleteSteps || [],
          stepResults: stepResults.slice(),
          sharedArtifacts: { ...sharedArtifacts },
          routingGuardTriggered: Boolean(extras.routingGuardTriggered),
          rejectedBackend: extras.rejectedBackend || null,
          userPrompt: extras.userPrompt || null,
          error: extras.error || null,
          lifecycleTransitions: record ? record.transitions.slice() : [],
          timestamp: new Date().toISOString()
        };
        this.executionHistory.push(envelope);
        if (this.executionHistory.length > 50) this.executionHistory.shift();
        return envelope;
      };

      try {
        // 1. UNDERSTANDING -> GATHERING_CONTEXT
        if (!this.lifecycle.isCurrent(commandId, taskId) || (abortCtrl && abortCtrl.signal.aborted)) {
          return buildFinalEnvelope(timedOut ? LIFECYCLE_STATES.TIMEOUT : LIFECYCLE_STATES.CANCELLED, { error: timedOut ? 'Timed out' : 'Cancelled' });
        }

        const initialRouting = this.classifyAndRoute(text, {}, {
          requestedBackend: options.requestedBackend,
          strictRejectMismatch: options.strictRejectMismatch
        });

        this.lifecycle.transition(commandId, LIFECYCLE_STATES.GATHERING_CONTEXT, {
          backend: initialRouting.route === 'browser' || initialRouting.route === 'desktop' || initialRouting.route === 'cross_backend'
            ? initialRouting.route
            : 'none',
          understoodSummary: initialRouting.understoodSummary,
          detail: 'Gathering page, desktop, and semantic memory context'
        });

        const context = await this.gatherRelevantContext(text, initialRouting, abortCtrl ? abortCtrl.signal : null);
        if (!this.lifecycle.isCurrent(commandId, taskId) || (abortCtrl && abortCtrl.signal.aborted)) {
          const st = timedOut ? LIFECYCLE_STATES.TIMEOUT : LIFECYCLE_STATES.CANCELLED;
          if (timedOut) this.lifecycle.transition(commandId, LIFECYCLE_STATES.TIMEOUT, { detail: 'Timed out gathering context', error: 'Timed out' });
          return buildFinalEnvelope(st, { route: initialRouting.route, intent: initialRouting.intent, error: st });
        }

        // Re-classify with gathered context if initial route was ambiguous
        let routing = (options.resumeRouting && typeof options.resumeRouting === 'object')
          ? { ...options.resumeRouting, ambiguous: false }
          : (initialRouting.route === 'clarification'
              ? this.classifyAndRoute(text, context, { requestedBackend: options.requestedBackend, strictRejectMismatch: options.strictRejectMismatch })
              : initialRouting);

        // If caller explicitly supplied a structured plan, derive route from plan backends instead of stalling in clarification
        if (options.explicitPlan && Array.isArray(options.explicitPlan) && options.explicitPlan.length > 0 && routing.route === 'clarification') {
          const backends = new Set(options.explicitPlan.map((s) => s.backend).filter(Boolean));
          const derivedRoute = backends.size > 1 ? 'cross_backend' : (backends.has('desktop') ? 'desktop' : 'browser');
          routing = {
            ...routing,
            route: derivedRoute,
            direction: derivedRoute,
            ambiguous: false,
            understoodSummary: options.explicitPlan[0].label || text
          };
        }

        // Phase 5: Bounded asynchronous local AI fallback (qwen2.5:1.5b) when regex classification is ambiguous
        // (Only classifies when utterance carries semantic target cues; genuinely targetless commands stay WAITING_FOR_USER)
        if (routing.route === 'clarification' && !options.skipLocalAiFallback) {
          const aiRouting = await this._tryLocalAiIntentFallback(text, context, abortCtrl ? abortCtrl.signal : null);
          if (aiRouting && aiRouting.route && aiRouting.route !== 'clarification') {
            routing = aiRouting;
            this.routingHistory.push({
              timestamp: new Date().toISOString(),
              input: text,
              route: routing.route,
              intent: routing.intent,
              direction: routing.direction,
              confidence: routing.confidence,
              localAiModel: routing.localAiModel || 'qwen2.5:1.5b',
              routingGuardTriggered: false,
              rejectedBackend: null
            });
            if (this.routingHistory.length > 100) this.routingHistory.shift();
          }
        }

        // Handle strict mismatch rejection or genuine ambiguity -> WAITING_FOR_USER
        if (routing.route === 'mismatch_rejected') {
          this.lifecycle.transition(commandId, LIFECYCLE_STATES.FAILED, {
            backend: 'none',
            detail: routing.routingCorrectionReason,
            error: routing.routingCorrectionReason
          });
          return buildFinalEnvelope(LIFECYCLE_STATES.FAILED, {
            route: routing.route,
            intent: routing.intent,
            understoodSummary: routing.understoodSummary,
            routingGuardTriggered: true,
            rejectedBackend: routing.rejectedBackend,
            contextUsed: context,
            error: { code: 'ROUTING_MISMATCH', message: routing.routingCorrectionReason }
          });
        }

        if (routing.route === 'clarification') {
          this.lifecycle.transition(commandId, LIFECYCLE_STATES.WAITING_FOR_USER, {
            backend: 'none',
            understoodSummary: routing.understoodSummary,
            userPrompt: routing.clarificationQuestion,
            detail: routing.clarificationQuestion
          });
          return buildFinalEnvelope(LIFECYCLE_STATES.WAITING_FOR_USER, {
            route: 'clarification',
            intent: routing.intent,
            understoodSummary: routing.understoodSummary,
            contextUsed: context,
            userPrompt: routing.clarificationQuestion
          });
        }

        // 2. PLANNING (Central Planner ONLY — enriched with local AI understanding for multi-step Chromium workflows)
        this.lifecycle.transition(commandId, LIFECYCLE_STATES.PLANNING, {
          backend: routing.route,
          understoodSummary: routing.understoodSummary,
          detail: `Planning ${routing.route} workflow`
        });

        if (!options.explicitPlan && routing.intent === 'BROWSER_SEARCH_AND_SELECT' && !options.skipLocalAiFallback) {
          const aiPlanInfo = await this._enrichCompoundPlanWithLocalAi(text, abortCtrl ? abortCtrl.signal : null);
          if (aiPlanInfo && aiPlanInfo.understanding) {
            sharedArtifacts.localAiPlanUnderstanding = {
              model: aiPlanInfo.model || 'qwen2.5:1.5b',
              source: aiPlanInfo.source || 'ollama:qwen2.5:1.5b',
              ...aiPlanInfo.understanding
            };
          }
        }

        const plan = options.explicitPlan
          ? {
              planId: generateId('plan'),
              route: routing.route,
              direction: routing.direction,
              intent: routing.intent,
              understoodSummary: routing.understoodSummary,
              steps: options.explicitPlan.map((s, i) => ({
                stepIndex: i + 1,
                stepId: s.stepId || `step-${i + 1}-${s.backend}-${s.action}`,
                idempotent: s.idempotent !== false,
                retryable: s.retryable !== false,
                timeout: s.timeout || 10000,
                ...s
              }))
            }
          : this.buildPlan(text, routing, context, options);

        if (!plan.steps || plan.steps.length === 0) {
          this.lifecycle.transition(commandId, LIFECYCLE_STATES.FAILED, {
            detail: 'Planner produced zero executable steps',
            error: 'Empty execution plan'
          });
          return buildFinalEnvelope(LIFECYCLE_STATES.FAILED, {
            route: routing.route,
            intent: routing.intent,
            understoodSummary: routing.understoodSummary,
            contextUsed: context,
            plan,
            error: { code: 'EMPTY_PLAN', message: 'Planner produced zero executable steps' }
          });
        }

        // 3. SEQUENTIAL STEP EXECUTION WITH RESOLVING -> EXECUTING -> VERIFYING & SAFE RECOVERY
        for (let i = 0; i < plan.steps.length; i++) {
          const step = plan.steps[i];
          const remainingAfter = plan.steps.slice(i);

          if (!this.lifecycle.isCurrent(commandId, taskId) || (abortCtrl && abortCtrl.signal.aborted)) {
            const st = timedOut ? LIFECYCLE_STATES.TIMEOUT : LIFECYCLE_STATES.CANCELLED;
            if (timedOut) this.lifecycle.transition(commandId, LIFECYCLE_STATES.TIMEOUT, { detail: `Timed out before step ${i + 1}`, error: 'Command timeout' });
            return buildFinalEnvelope(st, {
              route: routing.route,
              intent: routing.intent,
              understoodSummary: routing.understoodSummary,
              routingGuardTriggered: routing.routingGuardTriggered,
              rejectedBackend: routing.rejectedBackend,
              contextUsed: context,
              plan,
              incompleteSteps: remainingAfter.map((s) => ({ stepId: s.stepId, label: s.label, backend: s.backend })),
              error: { code: st, message: timedOut ? `Timed out after ${overallTimeoutMs}ms` : 'Cancelled during execution' }
            });
          }

          // Bind verified data from earlier steps (e.g., extractedInfo -> type_text; desktopText -> browser search)
          const resolvedStep = this._bindStepInputs(step, sharedArtifacts);

          // 3a. RESOLVING_TARGET
          const totalPlanSteps = priorStepCount + plan.steps.length;
          const displayStepIdx = priorStepCount + i + 1;
          const resTrans = this.lifecycle.transition(commandId, LIFECYCLE_STATES.RESOLVING_TARGET, {
            backend: resolvedStep.backend,
            currentStepIndex: displayStepIdx,
            totalSteps: totalPlanSteps,
            completedSteps,
            detail: resolvedStep.label
          });
          if (!resTrans.accepted) {
            return buildFinalEnvelope(LIFECYCLE_STATES.CANCELLED, {
              route: routing.route,
              intent: routing.intent,
              understoodSummary: routing.understoodSummary,
              contextUsed: context,
              plan,
              incompleteSteps: remainingAfter.map((s) => ({ stepId: s.stepId, label: s.label, backend: s.backend })),
              error: { code: 'STALE_COMMAND', message: 'Command superseded before target resolution' }
            });
          }

          // Execute step with bounded safe retry (NEVER restarting already-completed steps!)
          let stepPassed = false;
          let lastStepOutcome = null;
          let lastVerification = null;
          const maxAttempts = resolvedStep.retryable ? (1 + this.maxStepRetries) : 1;

          for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            if (attempt > 1) {
              const recTrans = this.lifecycle.transition(commandId, LIFECYCLE_STATES.RECOVERING, {
                backend: resolvedStep.backend,
                currentStepIndex: i + 1,
                totalSteps: plan.steps.length,
                completedSteps,
                detail: `Recovering step ${i + 1} (attempt ${attempt}/${maxAttempts}): ${resolvedStep.label}`
              });
              if (!recTrans.accepted) break;

              // Safe desktop focus recovery before retry if window mismatch
              if (resolvedStep.backend === 'desktop' && lastStepOutcome && lastStepOutcome.status === 'WINDOW_MISMATCH' && resolvedStep.target && (resolvedStep.target.hwnd || resolvedStep.target.processName)) {
                await this.desktopBackend.execute({
                  taskId,
                  commandId: `${commandId}-rec-${i + 1}-${attempt}`,
                  stepId: `${resolvedStep.stepId}-recover-focus`,
                  backend: 'desktop',
                  action: 'activate_window',
                  target: { hwnd: resolvedStep.target.hwnd, processName: resolvedStep.target.processName },
                  timeout: 4000,
                  signal: abortCtrl ? abortCtrl.signal : null
                }).catch(() => {});
              } else {
                await new Promise((r) => setTimeout(r, 150));
              }
            }

            // 3b. EXECUTING
            const execTrans = this.lifecycle.transition(commandId, LIFECYCLE_STATES.EXECUTING, {
              backend: resolvedStep.backend,
              currentStepIndex: i + 1,
              totalSteps: plan.steps.length,
              completedSteps,
              detail: resolvedStep.label
            });
            if (!execTrans.accepted) break;

            const stepCmdId = `${commandId}-s${i + 1}-a${attempt}`;
            const taskReq = createTaskRequest({
              taskId,
              commandId: stepCmdId,
              stepId: resolvedStep.stepId,
              backend: resolvedStep.backend,
              action: resolvedStep.action,
              target: resolvedStep.target,
              parameters: resolvedStep.parameters,
              expectedState: resolvedStep.expectedState,
              timeout: resolvedStep.timeout,
              signal: abortCtrl ? abortCtrl.signal : null
            });

            // Optional abort-aware UI settle delay (e.g., waiting for Windows modal Save As dialog to open)
            const settleMs = Number((resolvedStep.parameters && resolvedStep.parameters.delayBeforeMs) || 0);
            if (settleMs > 0) {
              await new Promise((resolve) => {
                if (abortCtrl && abortCtrl.signal.aborted) return resolve();
                const t = setTimeout(resolve, settleMs);
                if (abortCtrl) {
                  abortCtrl.signal.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
                }
              });
              if (!this.lifecycle.isCurrent(commandId, taskId) || (abortCtrl && abortCtrl.signal.aborted)) {
                break;
              }
            }

            const backendImpl = resolvedStep.backend === 'desktop' ? this.desktopBackend : this.browserBackend;
            const mayNavigateTab = Boolean(
              options.inBrowserTab &&
              resolvedStep.backend === 'browser' &&
              ['navigate', 'search', 'click'].includes(resolvedStep.action) &&
              typeof options.onBeforeNavigationStep === 'function'
            );
            if (mayNavigateTab) {
              await Promise.resolve(options.onBeforeNavigationStep({
                commandId,
                taskId,
                rawText: text,
                inputSource,
                route: routing.route,
                intent: routing.intent,
                understoodSummary: routing.understoodSummary,
                currentStep: resolvedStep,
                completedStepsBefore: completedSteps.slice(),
                remainingStepsAfter: plan.steps.slice(i + 1),
                sharedArtifacts: { ...sharedArtifacts }
              })).catch(() => {});
            }

            const execRes = await backendImpl.execute(taskReq);
            lastStepOutcome = execRes;

            if (mayNavigateTab && typeof options.onAfterInPageStep === 'function') {
              await Promise.resolve(options.onAfterInPageStep({ commandId, stepId: resolvedStep.stepId })).catch(() => {});
            }

            if (!this.lifecycle.isCurrent(commandId, taskId) || (abortCtrl && abortCtrl.signal.aborted) || execRes.status === 'CANCELLED') {
              const st = timedOut ? LIFECYCLE_STATES.TIMEOUT : LIFECYCLE_STATES.CANCELLED;
              if (timedOut) this.lifecycle.transition(commandId, LIFECYCLE_STATES.TIMEOUT, { detail: `Timed out during ${resolvedStep.label}`, error: 'Timeout' });
              stepResults.push({ step: resolvedStep, attempt, execution: execRes, verification: null });
              return buildFinalEnvelope(st, {
                route: routing.route,
                intent: routing.intent,
                understoodSummary: routing.understoodSummary,
                routingGuardTriggered: routing.routingGuardTriggered,
                rejectedBackend: routing.rejectedBackend,
                contextUsed: context,
                plan,
                incompleteSteps: remainingAfter.map((s) => ({ stepId: s.stepId, label: s.label, backend: s.backend })),
                error: { code: st, message: timedOut ? `Step '${resolvedStep.label}' timed out` : `Step '${resolvedStep.label}' cancelled` }
              });
            }

            // 3c. VERIFYING (Shared Verifier — dispatch alone is NEVER success!)
            const verTrans = this.lifecycle.transition(commandId, LIFECYCLE_STATES.VERIFYING, {
              backend: resolvedStep.backend,
              currentStepIndex: i + 1,
              totalSteps: plan.steps.length,
              completedSteps,
              detail: `Verifying: ${resolvedStep.label}`
            });
            if (!verTrans.accepted) break;

            const verification = resolvedStep.backend === 'desktop'
              ? await this.verifier.verifyDesktop(taskReq, execRes, this.desktopBackend)
              : await this.verifier.verifyBrowser(taskReq, execRes, (r) => this.browserBackend.probeState(r));
            lastVerification = verification;

            if (execRes.ok && verification.verified) {
              stepPassed = true;
              stepResults.push({ step: resolvedStep, attempt, execution: execRes, verification });
              completedSteps.push({ stepId: resolvedStep.stepId, label: resolvedStep.label, backend: resolvedStep.backend, engine: execRes.engine, attempt });
              this._captureStepArtifact(resolvedStep, execRes, verification, sharedArtifacts);

              // Phase 5: Webpage summarization via local Ollama llama3.2:3b (instead of raw DOM text dump)
              if (resolvedStep.parameters && resolvedStep.parameters.summarizeWithLocalAi) {
                const rawPageText = String(
                  (execRes.result && (execRes.result.fullExcerpt || execRes.result.extractedText || execRes.result.text)) ||
                  sharedArtifacts.extractedInfo ||
                  ''
                ).trim();
                const pageTitle = String((execRes.result && execRes.result.title) || (context.browser && context.browser.title) || '');
                if (rawPageText) {
                  const aiSum = await this._summarizeExtractedTextWithLocalAi(rawPageText, text, pageTitle, abortCtrl ? abortCtrl.signal : null);
                  if (aiSum && aiSum.summary) {
                    sharedArtifacts.extractedInfo = aiSum.summary;
                    sharedArtifacts.summaryModel = aiSum.model || 'llama3.2:3b';
                    sharedArtifacts.usedLocalAiSummary = Boolean(aiSum.usedLocalAi);
                  }
                }
              }

              // Chromium Multi-Result Comparison via Local AI (compares titles & descriptions across top N results)
              if (resolvedStep.parameters && resolvedStep.parameters.compareResultsWithLocalAi) {
                const extractedResults = (execRes.result && Array.isArray(execRes.result.searchResults) && execRes.result.searchResults) ||
                  (Array.isArray(sharedArtifacts.searchResults) ? sharedArtifacts.searchResults : []);
                sharedArtifacts.inspectedResults = extractedResults;
                sharedArtifacts.resultsPageUrl = (execRes.actualState && execRes.actualState.url) || (execRes.result && execRes.result.url) || '';
                if (extractedResults.length > 0) {
                  const cmp = await this._compareSearchResultsWithLocalAi(
                    extractedResults,
                    resolvedStep.parameters.query || text,
                    resolvedStep.parameters.userRequest || text,
                    abortCtrl ? abortCtrl.signal : null
                  );
                  const chosen = (cmp && cmp.selectedCandidate) || extractedResults[0];
                  sharedArtifacts.selectedResult = chosen;
                  sharedArtifacts.comparisonModel = (cmp && cmp.model) || null;
                  sharedArtifacts.usedLocalAiComparison = Boolean(cmp && cmp.usedLocalAi);
                  sharedArtifacts.selectionReason = (cmp && cmp.selectionReason) || `Selected "${chosen.title}".`;
                  sharedArtifacts.comparisonSummary = (cmp && cmp.comparisonSummary) || sharedArtifacts.selectionReason;
                  sharedArtifacts.extractedInfo = `Opened #${chosen.rank} "${chosen.title}" after comparing ${extractedResults.length} results. ${sharedArtifacts.selectionReason}`;
                }
              }
              break;
            }

            // Do not retry non-recoverable failures (cancelled, emergency stop, privilege required)
            if (execRes.error && execRes.error.recoverable === false) {
              stepResults.push({ step: resolvedStep, attempt, execution: execRes, verification });
              break;
            }
            if (attempt === maxAttempts) {
              stepResults.push({ step: resolvedStep, attempt, execution: execRes, verification });
            }
          }

          if (!stepPassed) {
            const isTimeout = lastStepOutcome && lastStepOutcome.status === 'TIMEOUT';
            const terminal = isTimeout ? LIFECYCLE_STATES.TIMEOUT : LIFECYCLE_STATES.FAILED;
            const errCode = (lastVerification && !lastVerification.verified && lastStepOutcome && lastStepOutcome.ok)
              ? 'VERIFICATION_FAILED'
              : ((lastStepOutcome && lastStepOutcome.status) || 'FAILED');
            const errMsg = (lastVerification && lastVerification.failureReason) ||
              (lastStepOutcome && lastStepOutcome.error && lastStepOutcome.error.message) ||
              `Step '${resolvedStep.label}' failed`;

            this.lifecycle.transition(commandId, terminal, {
              backend: resolvedStep.backend,
              currentStepIndex: i + 1,
              totalSteps: plan.steps.length,
              completedSteps,
              detail: errMsg,
              error: errMsg
            });

            return buildFinalEnvelope(terminal, {
              route: routing.route,
              intent: routing.intent,
              understoodSummary: routing.understoodSummary,
              routingGuardTriggered: routing.routingGuardTriggered,
              rejectedBackend: routing.rejectedBackend,
              contextUsed: context,
              plan,
              incompleteSteps: remainingAfter.map((s) => ({ stepId: s.stepId, label: s.label, backend: s.backend })),
              error: { code: errCode, message: errMsg, failedStepId: resolvedStep.stepId }
            });
          }
        }

        // 4. ALL STEPS VERIFIED -> COMPLETED
        const doneTrans = this.lifecycle.transition(commandId, LIFECYCLE_STATES.COMPLETED, {
          backend: routing.route,
          currentStepIndex: plan.steps.length,
          totalSteps: plan.steps.length,
          completedSteps,
          detail: routing.understoodSummary
        });

        if (!doneTrans.accepted) {
          return buildFinalEnvelope(LIFECYCLE_STATES.CANCELLED, {
            route: routing.route,
            intent: routing.intent,
            understoodSummary: routing.understoodSummary,
            contextUsed: context,
            plan,
            error: { code: 'STALE_COMMAND', message: 'Command became stale before completion' }
          });
        }

        // Store non-sensitive summary in targeted semantic memory (non-blocking bounded)
        await this.memoryBridge.recordCommandOutcome({
          commandId,
          commandText: text,
          summary: `${routing.understoodSummary}${sharedArtifacts.extractedInfo ? ` -> ${String(sharedArtifacts.extractedInfo).slice(0, 80)}` : ''}`,
          backend: routing.route,
          status: LIFECYCLE_STATES.COMPLETED,
          url: context.browser ? context.browser.url : ''
        }).catch(() => {});

        return buildFinalEnvelope(LIFECYCLE_STATES.COMPLETED, {
          route: routing.route,
          intent: routing.intent,
          understoodSummary: routing.understoodSummary,
          routingGuardTriggered: routing.routingGuardTriggered,
          rejectedBackend: routing.rejectedBackend,
          contextUsed: context,
          plan,
          incompleteSteps: []
        });
      } catch (err) {
        const isAbort = Boolean((abortCtrl && abortCtrl.signal.aborted) || (err && /cancel/i.test(err.message || '')));
        const terminal = timedOut ? LIFECYCLE_STATES.TIMEOUT : (isAbort ? LIFECYCLE_STATES.CANCELLED : LIFECYCLE_STATES.FAILED);
        const errMsg = (err && err.message) || String(err);
        if (this.lifecycle.isCurrent(commandId, taskId)) {
          this.lifecycle.transition(commandId, terminal, { detail: errMsg, error: errMsg });
        }
        return buildFinalEnvelope(terminal, { error: { code: terminal, message: errMsg } });
      } finally {
        if (globalTimer) clearTimeout(globalTimer);
        if (this.activeCommandId === commandId) {
          this.activeAbortController = null;
          this.activeCommandId = null;
          this.activeTaskId = null;
        }
      }
    }

    _bindStepInputs(step, artifacts) {
      const cloned = {
        ...step,
        target: { ...(step.target || {}) },
        parameters: { ...(step.parameters || {}) },
        expectedState: step.expectedState ? { ...step.expectedState } : null
      };

      // Propagate launched desktop window HWND into subsequent desktop steps targeting the same app
      if (cloned.backend === 'desktop' && artifacts.desktopWindow && artifacts.desktopWindow.hwnd && !cloned.target.hwnd) {
        const wantProc = String(cloned.target.processName || '').toLowerCase();
        const gotProc = String(artifacts.desktopWindow.processName || '').toLowerCase();
        if (!wantProc || gotProc.includes(wantProc) || wantProc.includes(gotProc)) {
          cloned.target.hwnd = artifacts.desktopWindow.hwnd;
        }
      }

      if (cloned.bindFromKey && artifacts[cloned.bindFromKey] !== undefined) {
        const boundObj = artifacts[cloned.bindFromKey];
        if (cloned.bindFromKey === 'selectedResult' && boundObj && typeof boundObj === 'object') {
          cloned.target.label = String(boundObj.title || cloned.target.label || '__first_result__');
          if (boundObj.href) {
            try {
              const u = new URL(boundObj.href, 'https://www.youtube.com');
              const ytVid = u.searchParams.get('v');
              cloned.target.hrefContains = ytVid
                ? `${u.pathname}?v=${ytVid}`
                : (u.search ? `${u.pathname}${u.search}` : u.pathname);
            } catch (_e) {
              cloned.target.hrefContains = String(boundObj.href);
            }
          }
          if (cloned.expectedState && artifacts.resultsPageUrl) {
            cloned.expectedState.urlNotEquals = artifacts.resultsPageUrl;
          }
          return cloned;
        }
        const rawVal = String(boundObj).trim();
        const val = typeof cloned.bindTransform === 'function' ? cloned.bindTransform(rawVal) : rawVal;
        if (cloned.backend === 'desktop' && cloned.action === 'type_text') {
          const textWithBreak = `\n${val}`;
          cloned.target.text = textWithBreak;
          cloned.parameters.text = textWithBreak;
          if (cloned.expectedState) {
            cloned.expectedState.uiaTextContains = val;
          }
        } else if (cloned.backend === 'browser' && (cloned.action === 'search' || cloned.action === 'fill')) {
          cloned.parameters.query = val;
          cloned.parameters.value = val;
          if (cloned.expectedState && !cloned.expectedState.domTextContains) {
            cloned.expectedState.domTextContains = val;
          }
        } else if (cloned.backend === 'browser' && cloned.action === 'navigate' && cloned.parameters.urlTemplate) {
          cloned.target.url = cloned.parameters.urlTemplate.replace('{value}', encodeURIComponent(val));
        }
      }

      return cloned;
    }

    _captureStepArtifact(step, execRes, verification, artifacts) {
      // Track truthful input mechanism telemetry for EVERY browser & desktop step
      if (!artifacts.inputMechanismSummary || typeof artifacts.inputMechanismSummary !== 'object') {
        artifacts.inputMechanismSummary = {
          cdp_mouse_input: 0,
          cdp_keyboard_input: 0,
          cdp_mouse_and_keyboard_input: 0,
          windows_send_input: 0,
          windows_ui_automation: 0,
          semantic_browser_operation: 0,
          visual_fallback: 0
        };
      }
      let mech = (execRes && execRes.evidence && execRes.evidence.inputMechanism) ||
        (execRes && execRes.result && execRes.result.inputMechanism) ||
        null;
      if (!mech && step) {
        if (step.backend === 'desktop') {
          mech = /^(?:type_text|press_key|key_combination|mouse_)/.test(step.action)
            ? 'windows_send_input'
            : 'windows_ui_automation';
        } else {
          mech = 'semantic_browser_operation';
        }
      }
      if (mech && Object.prototype.hasOwnProperty.call(artifacts.inputMechanismSummary, mech)) {
        artifacts.inputMechanismSummary[mech] += 1;
      }

      if (step.action === 'interact_control' && execRes && execRes.result) {
        if (!Array.isArray(artifacts.hierarchicalStepsAudit)) {
          artifacts.hierarchicalStepsAudit = [];
        }
        artifacts.hierarchicalStepsAudit.push({
          stepId: step.stepId,
          label: step.label,
          matchedControl: execRes.result.matchedControl || null,
          parentExpanded: Boolean(execRes.result.parentExpanded),
          parentTriggerLabel: execRes.result.parentTriggerLabel || null,
          beforeInventoryVersion: execRes.result.beforeInventoryVersion || 0,
          afterInventoryVersion: execRes.result.afterInventoryVersion || 0,
          reinspected: Boolean(execRes.result.reinspected),
          controlVerified: Boolean(execRes.result.controlVerified),
          verifiedState: execRes.result.verifiedState || null,
          usedStagehand: Boolean(execRes.result.usedStagehand),
          inputMechanism: mech
        });
      }
      if (!step.outputKey) return;
      if (step.outputKey === 'extractedInfo') {
        const text = String(
          (execRes.result && (execRes.result.extractedText || execRes.result.text || execRes.result.summary)) ||
          (verification && verification.actualState && verification.actualState.extractedText) ||
          ''
        ).trim();
        if (text) artifacts.extractedInfo = text;
      } else if (step.outputKey === 'searchResults') {
        const list = (execRes.result && Array.isArray(execRes.result.searchResults) && execRes.result.searchResults) ||
          (verification && verification.actualState && Array.isArray(verification.actualState.searchResults) && verification.actualState.searchResults) ||
          [];
        artifacts.searchResults = list;
      } else if (step.outputKey === 'openedResultPage') {
        artifacts.openedResultPage = {
          url: (execRes.actualState && execRes.actualState.url) || (execRes.result && execRes.result.url) || '',
          title: (execRes.actualState && execRes.actualState.title) || (execRes.result && execRes.result.title) || ''
        };
      } else if (step.outputKey === 'desktopText') {
        const text = String(
          (execRes.result && execRes.result.text) ||
          (verification && verification.actualState && verification.actualState.uiaText) ||
          ''
        ).trim();
        if (text) artifacts.desktopText = text;
      } else if (step.outputKey === 'desktopWindow') {
        const win = (verification && verification.actualState && verification.actualState.window) ||
          (execRes.actualState && execRes.actualState.window) ||
          execRes.targetIdentity;
        if (win && win.hwnd) artifacts.desktopWindow = win;
      } else {
        artifacts[step.outputKey] = execRes.result;
      }
    }

    async _tryLocalAiIntentFallback(rawText, context = {}, signal = null) {
      const clean = String(rawText || '').trim();
      if (!clean || containsSensitiveData(clean)) return null;
      // Preserve WAITING_FOR_USER for genuinely targetless commands (e.g., "Type hello", "Write a note", "Save this")
      const hasAnyDomainCue = /\b(?:page|webpage|article|site|website|browser|chrome|tab|link|button|youtube|wikipedia|google|github|notepad|calculator|calc|desktop|explorer|settings|window|screen|summarize|overview|gist)\b/i.test(clean);
      if (!hasAnyDomainCue) return null;

      if (signal && signal.aborted) return null;
      const payload = {
        utterance: scrubSensitive(clean.slice(0, 280)),
        pageTitle: String((context && context.browser && context.browser.title) || '').slice(0, 120),
        pageUrl: String((context && context.browser && context.browser.url) || '').slice(0, 160),
        activeDesktopProcess: String((context && context.desktop && context.desktop.activeWindow && context.desktop.activeWindow.processName) || '').slice(0, 60)
      };

      let resp = null;
      if (typeof chrome !== 'undefined' && chrome.runtime && typeof chrome.runtime.sendMessage === 'function') {
        resp = await new Promise((resolve) => {
          const t = setTimeout(() => resolve(null), 16000);
          const onAbort = () => { clearTimeout(t); resolve(null); };
          if (signal) signal.addEventListener('abort', onAbort, { once: true });
          try {
            chrome.runtime.sendMessage({ type: 'SLEEPWALKER_UNIFIED_INTENT_REQUEST', payload }, (r) => {
              clearTimeout(t);
              if (signal) signal.removeEventListener('abort', onAbort);
              void chrome.runtime?.lastError;
              resolve(r || null);
            });
          } catch (_e) {
            clearTimeout(t);
            resolve(null);
          }
        });
      }

      if (!resp || resp.status !== 'ok' || !resp.decision) return null;
      const d = resp.decision;
      if (!d.route || d.route === 'clarification' || Number(d.confidence || 0) < 0.72) return null;

      if (d.route === 'desktop') {
        const app = DESKTOP_APP_CATALOG.find((a) => a.name.toLowerCase() === String(d.app || 'Notepad').toLowerCase()) || DESKTOP_APP_CATALOG[0];
        if (d.intent === 'DESKTOP_LAUNCH_AND_TYPE' && d.value) {
          return {
            route: 'desktop',
            direction: 'desktop_only',
            backends: ['desktop'],
            intent: 'DESKTOP_LAUNCH_AND_TYPE',
            desktopApp: app,
            subDetails: { intent: 'DESKTOP_LAUNCH_AND_TYPE', desktopApp: app, textToType: String(d.value).slice(0, 240), summary: d.summary || `Open ${app.name} and type text` },
            confidence: Number(d.confidence),
            localAiModel: resp.model || 'qwen2.5:1.5b',
            understoodSummary: d.summary || `Open ${app.name} and type verified text`,
            rationale: 'Classified via local Ollama qwen2.5:1.5b'
          };
        }
        return {
          route: 'desktop',
          direction: 'desktop_only',
          backends: ['desktop'],
          intent: 'DESKTOP_LAUNCH_APP',
          desktopApp: app,
          subDetails: { intent: 'DESKTOP_LAUNCH_APP', desktopApp: app, summary: d.summary || `Launch ${app.name}` },
          confidence: Number(d.confidence),
          localAiModel: resp.model || 'qwen2.5:1.5b',
          understoodSummary: d.summary || `Launch ${app.name}`,
          rationale: 'Classified via local Ollama qwen2.5:1.5b'
        };
      }

      if (d.route === 'browser') {
        const subIntent = d.intent === 'BROWSER_SUMMARIZE' ? 'BROWSER_SUMMARIZE'
          : (d.intent === 'BROWSER_CLICK' && d.target ? 'BROWSER_CLICK'
          : (d.intent === 'BROWSER_SEARCH' && d.value ? 'BROWSER_SEARCH' : 'BROWSER_SUMMARIZE'));
        return {
          route: 'browser',
          direction: 'browser_only',
          backends: ['browser'],
          intent: subIntent,
          subDetails: {
            intent: subIntent,
            label: String(d.target || '').slice(0, 120),
            query: String(d.value || clean).slice(0, 180),
            url: d.url || `https://www.google.com/search?q=${encodeURIComponent(String(d.value || clean))}`,
            summary: d.summary || 'Execute browser action'
          },
          confidence: Number(d.confidence),
          localAiModel: resp.model || 'qwen2.5:1.5b',
          understoodSummary: d.summary || 'Execute browser action',
          rationale: 'Classified via local Ollama qwen2.5:1.5b'
        };
      }
      return null;
    }

    async _summarizeExtractedTextWithLocalAi(rawText, userQuery = '', pageTitle = '', signal = null) {
      const cleanText = scrubSensitive(String(rawText || '').replace(/\s+/g, ' ').trim()).slice(0, 2400);
      if (!cleanText || (signal && signal.aborted)) return null;

      if (typeof chrome !== 'undefined' && chrome.runtime && typeof chrome.runtime.sendMessage === 'function') {
        const resp = await new Promise((resolve) => {
          const t = setTimeout(() => resolve(null), 20000);
          const onAbort = () => { clearTimeout(t); resolve(null); };
          if (signal) signal.addEventListener('abort', onAbort, { once: true });
          try {
            chrome.runtime.sendMessage({
              type: 'SLEEPWALKER_SUMMARIZE_PAGE',
              payload: {
                text: cleanText,
                title: String(pageTitle || '').slice(0, 140),
                query: scrubSensitive(String(userQuery || '').slice(0, 180))
              }
            }, (r) => {
              clearTimeout(t);
              if (signal) signal.removeEventListener('abort', onAbort);
              void chrome.runtime?.lastError;
              resolve(r || null);
            });
          } catch (_e) {
            clearTimeout(t);
            resolve(null);
          }
        });
        if (resp && resp.status === 'ok' && resp.summary) {
          return { summary: String(resp.summary).trim(), model: resp.model || 'llama3.2:3b', usedLocalAi: true };
        }
      }
      return null;
    }

    async _enrichCompoundPlanWithLocalAi(rawText, signal = null) {
      const clean = scrubSensitive(String(rawText || '').trim()).slice(0, 340);
      if (!clean || (signal && signal.aborted)) return null;
      if (typeof chrome !== 'undefined' && chrome.runtime && typeof chrome.runtime.sendMessage === 'function') {
        return new Promise((resolve) => {
          const t = setTimeout(() => resolve(null), 15000);
          const onAbort = () => { clearTimeout(t); resolve(null); };
          if (signal) signal.addEventListener('abort', onAbort, { once: true });
          try {
            chrome.runtime.sendMessage({
              type: 'SLEEPWALKER_BROWSER_AI_UNDERSTAND',
              payload: { utterance: clean, timeoutMs: 14000 }
            }, (r) => {
              clearTimeout(t);
              if (signal) signal.removeEventListener('abort', onAbort);
              void chrome.runtime?.lastError;
              resolve(r && r.status === 'ok' ? r : null);
            });
          } catch (_e) {
            clearTimeout(t);
            resolve(null);
          }
        });
      }
      return null;
    }

    async _compareSearchResultsWithLocalAi(candidates, searchQuery, userRequest, signal = null) {
      if (!Array.isArray(candidates) || candidates.length === 0 || (signal && signal.aborted)) return null;
      if (typeof chrome !== 'undefined' && chrome.runtime && typeof chrome.runtime.sendMessage === 'function') {
        return new Promise((resolve) => {
          const t = setTimeout(() => resolve(null), 20000);
          const onAbort = () => { clearTimeout(t); resolve(null); };
          if (signal) signal.addEventListener('abort', onAbort, { once: true });
          try {
            chrome.runtime.sendMessage({
              type: 'SLEEPWALKER_COMPARE_SEARCH_RESULTS',
              payload: {
                candidates,
                searchQuery: scrubSensitive(String(searchQuery || '').slice(0, 140)),
                userRequest: scrubSensitive(String(userRequest || '').slice(0, 280)),
                timeoutMs: 18000
              }
            }, (r) => {
              clearTimeout(t);
              if (signal) signal.removeEventListener('abort', onAbort);
              void chrome.runtime?.lastError;
              resolve(r || null);
            });
          } catch (_e) {
            clearTimeout(t);
            resolve(null);
          }
        });
      }
      // Node/non-extension fallback scorer
      return {
        status: 'deterministic_fallback',
        usedLocalAi: false,
        selectedId: candidates[0].id,
        selectedCandidate: candidates[0],
        selectionReason: `Selected "${candidates[0].title}".`,
        comparisonSummary: `Selected "${candidates[0].title}".`
      };
    }
  }

  const exported = {
    TargetedMemoryBridge,
    SleepwalkerUnifiedOrchestrator,
    containsSensitiveData,
    scrubSensitive
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = exported;
  }
  if (rootScope) {
    rootScope.SleepwalkerUnifiedOrchestrator = SleepwalkerUnifiedOrchestrator;
    rootScope.SleepwalkerTargetedMemoryBridge = TargetedMemoryBridge;
  }
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));
