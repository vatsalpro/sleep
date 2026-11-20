/**
 * Sleepwalker Page Digest Builder
 * Builds compact, privacy-safe page representations (title, heading tree,
 * numbered interactive elements [id|type|label], and section-indexed chunks)
 * strictly within LLM token budgets.
 *
 * Security / Privacy guarantees:
 * - NEVER reads input/textarea/select .value or typed user text.
 * - NEVER includes password inputs, hidden inputs, cookies, or URL query strings.
 * - NEVER includes CSS selectors in outputs; elements are referenced solely by numeric id.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  if (root && typeof root === 'object') {
    root.SleepwalkerDigest = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const DEFAULT_CLOUD_DIGEST_TOKENS = 1500;
  const DEFAULT_OLLAMA_DIGEST_TOKENS = 800;
  const DEFAULT_MAX_CHUNK_TOKENS = 1200;
  const DEFAULT_MAX_CHUNKS = 3;

  const DEVANAGARI_DIGITS = {
    '०': '0', '१': '1', '२': '2', '३': '3', '४': '4',
    '५': '5', '६': '6', '७': '7', '८': '8', '९': '9'
  };

  const STOPWORDS = new Set([
    'a', 'an', 'the', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
    'in', 'on', 'at', 'to', 'for', 'of', 'with', 'by', 'from', 'as', 'into',
    'this', 'that', 'these', 'those', 'it', 'its', 'my', 'your', 'our',
    'what', 'which', 'who', 'whom', 'where', 'when', 'why', 'how',
    'do', 'does', 'did', 'can', 'could', 'should', 'would', 'will',
    'and', 'or', 'but', 'if', 'about', 'page', 'tell', 'me', 'explain',
    'please', 'simple', 'words', 'like', 'im', 'ten',
    'kya', 'hai', 'hain', 'ka', 'ki', 'ke', 'ko', 'mein', 'me', 'se',
    'par', 'pe', 'ye', 'yeh', 'wo', 'woh', 'kitni', 'kitna', 'kitne',
    'kaise', 'kab', 'kahan', 'kaun', 'batao', 'samjhao', 'mujhe', 'ise',
    'क्या', 'है', 'हैं', 'का', 'की', 'के', 'को', 'में', 'से', 'पर',
    'यह', 'ये', 'वह', 'वो', 'कितनी', 'कितना', 'कितने', 'कैसे', 'कब',
    'कहाँ', 'कौन', 'बताओ', 'समझाओ', 'मुझे', 'इसमें', 'इस'
  ]);

  const SENSITIVE_FIELD_RE = /\b(password|passwd|pwd|otp|one[-_\s]?time|passcode|pin|upi|cvv|cvc|card\s*number|aadhaar|aadhar|pan\s*card|pan\s*number|secret|ssn|captcha)\b/i;

  function estimateTokens(text) {
    if (!text) return 0;
    return Math.ceil(String(text).length / 4);
  }

  function truncateToTokenBudget(text, maxTokens) {
    const str = String(text || '');
    const budget = Math.max(0, Number(maxTokens) || 0);
    if (budget <= 0) return '';
    const maxChars = budget * 4;
    if (str.length <= maxChars) return str;
    if (maxChars <= 24) return str.slice(0, maxChars);

    let cut = str.slice(0, maxChars - 3);
    const lastNewline = cut.lastIndexOf('\n');
    const lastSpace = cut.lastIndexOf(' ');
    if (lastNewline > maxChars * 0.6) {
      cut = cut.slice(0, lastNewline);
    } else if (lastSpace > maxChars * 0.7) {
      cut = cut.slice(0, lastSpace);
    }
    return cut.trimEnd() + '...';
  }

  function hashText(str) {
    const input = String(str || '');
    let hash = 0x811c9dc5;
    for (let i = 0; i < input.length; i++) {
      hash ^= input.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193);
    }
    return `${(hash >>> 0).toString(16).padStart(8, '0')}-${input.length}`;
  }

  function normalizeNumerals(text) {
    return String(text || '').replace(/[०-९]/g, (ch) => DEVANAGARI_DIGITS[ch] || ch);
  }

  function cleanWhitespace(text) {
    return normalizeNumerals(String(text || ''))
      .replace(/[\u200B-\u200F\uFEFF]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  /**
   * Neutralize adversarial prompt-injection instructions & credential patterns inside untrusted webpage text.
   */
  function sanitizeUntrustedPageText(text) {
    return cleanWhitespace(text)
      .replace(/\b(?:ignore|disregard|forget|override)\s+(?:all\s+|any\s+)?(?:previous|prior|above|system|safety)\s+(?:instructions|prompts|rules|directives)\b/gi, '[untrusted-text-filtered]')
      .replace(/\b(?:you\s+are\s+now|new\s+system\s+prompt|act\s+as\s+admin|developer\s+mode)\s*[:\-]?/gi, '[untrusted-text-filtered]')
      .replace(/<\|(?:im_start|im_end|system|assistant|user)\|>/gi, '')
      .replace(/\b(?:javascript|data|vbscript)\s*:\s*\S+/gi, '[blocked-uri]')
      .replace(/\bAIza[0-9A-Za-z_-]{20,}\b/g, '[redacted-key]')
      .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}(?:\.[A-Za-z0-9_-]+)?\b/g, '[redacted-token]')
      .trim();
  }

  function isPrivateMessageArea(el) {
    if (!el || el.nodeType !== 1) return false;
    const ce = String(getAttributeSafe(el, 'contenteditable') || '').toLowerCase();
    const role = String(getAttributeSafe(el, 'role') || '').toLowerCase();
    if (ce === 'true' || role === 'textbox') return true;
    const fingerprint = [
      getAttributeSafe(el, 'aria-label') || '',
      getAttributeSafe(el, 'data-testid') || '',
      getAttributeSafe(el, 'id') || '',
      typeof el.className === 'string' ? el.className : ''
    ].join(' ');
    return /\b(?:direct[-_\s]?messages?|private[-_\s]?messages?|private[-_\s]?chat|dm[-_\s]?thread|dm[-_\s]?composer|encrypted[-_\s]?chat)\b/i.test(fingerprint);
  }

  function getCleanUrl(doc) {
    try {
      const targetDoc = doc || (typeof document !== 'undefined' ? document : null);
      const loc = targetDoc && targetDoc.location ? targetDoc.location : (typeof window !== 'undefined' ? window.location : null);
      if (!loc) return 'unknown';
      if (loc.protocol === 'file:') {
        return String(loc.href || 'file://').split(/[?#]/)[0];
      }
      if (loc.origin && loc.origin !== 'null') {
        return `${loc.origin}${loc.pathname || '/'}`;
      }
      return String(loc.href || 'unknown').split(/[?#]/)[0];
    } catch (_e) {
      return 'unknown';
    }
  }

  function isElementVisible(el, doc) {
    if (!el || el.nodeType !== 1) return false;
    try {
      if (el.hidden || el.getAttribute('aria-hidden') === 'true') return false;
      const styleAttr = String(el.getAttribute('style') || '').toLowerCase();
      if (/display\s*:\s*none|visibility\s*:\s*hidden/.test(styleAttr)) return false;

      const win = (doc && doc.defaultView) || (typeof window !== 'undefined' ? window : null);
      if (win && typeof win.getComputedStyle === 'function') {
        const style = win.getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0' || parseFloat(style.opacity || '1') <= 0.02) {
          return false;
        }
        const fz = parseFloat(style.fontSize || '14');
        if (Number.isFinite(fz) && fz > 0 && fz <= 1) {
          return false;
        }
      }
      if (typeof el.getClientRects === 'function' && el.getClientRects().length === 0) {
        // Note: fallback when DOM isn't laid out (e.g., jsdom / mocked DOM): allow if no computed zero rect
        if (el.offsetWidth === 0 && el.offsetHeight === 0 && styleAttr.includes('none')) {
          return false;
        }
      }
      return true;
    } catch (_e) {
      return true;
    }
  }

  function isInsideSleepwalker(el) {
    let cur = el;
    while (cur && cur.nodeType === 1) {
      if (cur.id === 'sleepwalker-host' || (cur.classList && cur.classList.contains('sleepwalker-ignore'))) {
        return true;
      }
      cur = cur.parentElement;
    }
    return false;
  }

  function getAttributeSafe(el, name) {
    return typeof el.getAttribute === 'function' ? el.getAttribute(name) : null;
  }

  function isSensitiveField(el, labelText) {
    const tag = String(el.tagName || '').toLowerCase();
    const type = String(getAttributeSafe(el, 'type') || '').toLowerCase();
    if (tag === 'input' && (type === 'password' || type === 'hidden')) {
      return true;
    }
    if (tag === 'input' || tag === 'textarea' || tag === 'select') {
      const fingerprint = [
        getAttributeSafe(el, 'id') || '',
        getAttributeSafe(el, 'name') || '',
        getAttributeSafe(el, 'autocomplete') || '',
        getAttributeSafe(el, 'placeholder') || '',
        getAttributeSafe(el, 'aria-label') || '',
        labelText || ''
      ].join(' ');
      if (SENSITIVE_FIELD_RE.test(fingerprint)) {
        return true;
      }
    }
    return false;
  }

  function resolveInteractiveLabel(el, doc) {
    const ariaLabel = cleanWhitespace(getAttributeSafe(el, 'aria-label'));
    if (ariaLabel) return ariaLabel;

    const labelledBy = cleanWhitespace(getAttributeSafe(el, 'aria-labelledby'));
    if (labelledBy && doc && typeof doc.getElementById === 'function') {
      const parts = labelledBy
        .split(/\s+/)
        .map((id) => doc.getElementById(id))
        .filter(Boolean)
        .map((node) => cleanWhitespace(node.innerText || node.textContent || ''));
      const joined = cleanWhitespace(parts.join(' '));
      if (joined) return joined;
    }

    const id = getAttributeSafe(el, 'id');
    if (id && doc && typeof doc.querySelectorAll === 'function') {
      const labels = doc.querySelectorAll('label[for]');
      for (let i = 0; i < labels.length; i++) {
        if (labels[i].getAttribute('for') === id) {
          const text = cleanWhitespace(labels[i].innerText || labels[i].textContent || '');
          if (text) return text;
        }
      }
    }

    if (typeof el.closest === 'function') {
      const wrapLabel = el.closest('label');
      if (wrapLabel) {
        // Clone-free text read excluding nested input/select/textarea descendants
        let labelText = '';
        const children = wrapLabel.childNodes || [];
        for (let i = 0; i < children.length; i++) {
          const ch = children[i];
          if (ch.nodeType === 3) {
            labelText += ' ' + ch.nodeValue;
          } else if (ch.nodeType === 1 && !/^(INPUT|SELECT|TEXTAREA|BUTTON)$/i.test(ch.tagName)) {
            labelText += ' ' + (ch.innerText || ch.textContent || '');
          }
        }
        const cleaned = cleanWhitespace(labelText);
        if (cleaned) return cleaned;
      }
    }

    const tag = String(el.tagName || '').toLowerCase();
    if (tag === 'a' || tag === 'button' || getAttributeSafe(el, 'role') === 'button' || getAttributeSafe(el, 'role') === 'link') {
      const text = cleanWhitespace(el.innerText || el.textContent || '');
      if (text) return text;
    }

    const type = String(getAttributeSafe(el, 'type') || '').toLowerCase();
    if (tag === 'input' && (type === 'submit' || type === 'button' || type === 'reset')) {
      // Static button caption attribute only (only safe non-user-data input types)
      const attrVal = cleanWhitespace(getAttributeSafe(el, 'value'));
      if (attrVal) return attrVal;
    }

    const placeholder = cleanWhitespace(getAttributeSafe(el, 'placeholder'));
    if (placeholder) return placeholder;

    const title = cleanWhitespace(getAttributeSafe(el, 'title'));
    if (title) return title;

    const name = cleanWhitespace(getAttributeSafe(el, 'name'));
    if (name) return name;

    return cleanWhitespace(el.innerText || el.textContent || '');
  }

  function classifyInteractiveElement(el) {
    const tag = String(el.tagName || '').toLowerCase();
    const role = String(getAttributeSafe(el, 'role') || '').toLowerCase();
    const type = String(getAttributeSafe(el, 'type') || '').toLowerCase();

    if (tag === 'a' || role === 'link') return 'link';
    if (tag === 'button' || role === 'button' || (tag === 'input' && (type === 'submit' || type === 'button' || type === 'reset'))) {
      return 'button';
    }
    if (tag === 'input' && type === 'file') return 'file';
    if (tag === 'select') return 'select';
    if (tag === 'textarea') return 'textarea';
    if (tag === 'input') {
      if (type === 'checkbox') return 'checkbox';
      if (type === 'radio') return 'radio';
      if (type === 'date' || type === 'datetime-local') return 'date';
      return 'field';
    }
    return role || 'control';
  }

  function collectHeadingsAndElements(doc) {
    const headings = [];
    const elements = [];

    if (!doc || !doc.body) {
      return { headings, elements };
    }

    // 1. Headings H1-H4 (H5/H6 if non-empty)
    if (typeof doc.querySelectorAll === 'function') {
      const headingNodes = doc.querySelectorAll('h1, h2, h3, h4, h5, h6');
      for (let i = 0; i < headingNodes.length; i++) {
        const h = headingNodes[i];
        if (isInsideSleepwalker(h) || !isElementVisible(h, doc)) continue;
        const text = sanitizeUntrustedPageText(h.innerText || h.textContent || '');
        if (!text) continue;
        const level = Number(String(h.tagName || 'H2').slice(1)) || 2;
        headings.push({
          id: `h${headings.length + 1}`,
          level,
          text: text.slice(0, 120)
        });
      }

      // 2. Interactive elements [id|type|label] — NEVER store .value or CSS selectors
      const interactiveNodes = doc.querySelectorAll(
        'a[href], button, input, select, textarea, [role="button"], [role="link"]'
      );
      for (let i = 0; i < interactiveNodes.length; i++) {
        const el = interactiveNodes[i];
        if (isInsideSleepwalker(el) || !isElementVisible(el, doc)) continue;

        const label = sanitizeUntrustedPageText(resolveInteractiveLabel(el, doc)).slice(0, 90);
        if (isSensitiveField(el, label)) continue;

        const type = classifyInteractiveElement(el);
        const cleanLabel = label || `${type} ${elements.length + 1}`;
        elements.push({
          id: elements.length + 1,
          type,
          label: cleanLabel,
          required: Boolean(el.required || getAttributeSafe(el, 'aria-required') === 'true'),
          accept: type === 'file' ? cleanWhitespace(getAttributeSafe(el, 'accept') || '') : ''
        });
        if (elements.length >= 120) break;
      }
    }

    return { headings, elements };
  }

  function extractCleanNodeLines(rootEl, doc, lines, currentSectionRef) {
    if (!rootEl) return;
    const nodes = rootEl.childNodes || [];
    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i];
      if (node.nodeType === 3) {
        const txt = cleanWhitespace(node.nodeValue || '');
        if (txt) {
          lines.push({ section: currentSectionRef.value, text: txt, isHeading: false });
        }
        continue;
      }
      if (node.nodeType !== 1) continue;

      const tag = String(node.tagName || '').toLowerCase();
      if (['script', 'style', 'noscript', 'template', 'svg', 'iframe', 'input', 'textarea', 'select', 'option', 'canvas', 'audio', 'video'].includes(tag)) {
        continue;
      }
      if (tag === 'nav' || tag === 'footer' || getAttributeSafe(node, 'role') === 'navigation') {
        continue;
      }
      if (isInsideSleepwalker(node) || !isElementVisible(node, doc) || isPrivateMessageArea(node)) {
        continue;
      }

      if (/^h[1-6]$/.test(tag)) {
        const hText = sanitizeUntrustedPageText(node.innerText || node.textContent || '');
        if (hText) {
          currentSectionRef.value = hText.slice(0, 100);
          lines.push({ section: currentSectionRef.value, text: hText, isHeading: true });
        }
        continue;
      }

      // If element has child element nodes, walk them to avoid reading child input values
      if (node.children && node.children.length > 0) {
        extractCleanNodeLines(node, doc, lines, currentSectionRef);
      } else {
        const leafText = sanitizeUntrustedPageText(node.innerText || node.textContent || '');
        if (leafText) {
          lines.push({ section: currentSectionRef.value, text: leafText, isHeading: false });
        }
      }
    }
  }

  function buildSectionChunks(doc, title, maxCharsPerChunk = 800) {
    if (!doc || !doc.body) return [];

    let contentRoot = null;
    if (typeof doc.querySelector === 'function') {
      contentRoot =
        doc.querySelector('main') ||
        doc.querySelector('[role="main"]') ||
        doc.querySelector('article') ||
        doc.body;
    } else {
      contentRoot = doc.body;
    }

    const lines = [];
    const currentSectionRef = { value: cleanWhitespace(title) || 'Overview' };
    extractCleanNodeLines(contentRoot, doc, lines, currentSectionRef);

    // Fallback to body if <main> was unexpectedly tiny/empty
    if (lines.length === 0 && contentRoot !== doc.body) {
      extractCleanNodeLines(doc.body, doc, lines, currentSectionRef);
    }

    const chunks = [];
    let activeSection = cleanWhitespace(title) || 'Overview';
    let buffer = '';

    const flush = () => {
      const cleaned = cleanWhitespace(buffer);
      if (cleaned) {
        chunks.push({
          id: `c${chunks.length + 1}`,
          index: chunks.length,
          section: activeSection,
          text: cleaned,
          tokens: estimateTokens(cleaned)
        });
      }
      buffer = '';
    };

    for (let i = 0; i < lines.length; i++) {
      const entry = lines[i];
      if (!entry.text) continue;

      if (entry.isHeading) {
        if (buffer.trim()) flush();
        activeSection = entry.section;
        buffer = entry.text;
        continue;
      }

      const candidate = buffer ? `${buffer} ${entry.text}` : entry.text;
      if (candidate.length > maxCharsPerChunk && buffer.trim()) {
        flush();
        activeSection = entry.section;
        buffer = entry.text;
      } else {
        buffer = candidate;
      }
    }
    flush();

    return chunks;
  }

  function buildDigest(doc, options = {}) {
    const targetDoc = doc || (typeof document !== 'undefined' ? document : null);
    const title = cleanWhitespace((targetDoc && targetDoc.title) || 'Untitled Page').slice(0, 140);
    const urlClean = getCleanUrl(targetDoc);
    const { headings, elements } = collectHeadingsAndElements(targetDoc);
    const chunks = buildSectionChunks(targetDoc, title, options.maxCharsPerChunk || 800);

    const safeTextParts = [title];
    for (let i = 0; i < chunks.length; i++) {
      safeTextParts.push(chunks[i].text);
    }
    const fullSafeText = safeTextParts.join('\n');
    const pageTextHash = hashText(fullSafeText);

    return {
      title,
      urlClean,
      pageTextHash,
      headings,
      elements,
      chunks,
      fullSafeText,
      stats: {
        headingCount: headings.length,
        elementCount: elements.length,
        chunkCount: chunks.length,
        totalTextTokens: estimateTokens(fullSafeText)
      }
    };
  }

  function normalizeSearchTokens(text) {
    const cleaned = normalizeNumerals(String(text || '').toLowerCase())
      .replace(/[^\p{L}\p{N}\s]/gu, ' ');
    const rawTokens = cleaned.split(/\s+/).filter(Boolean);
    const result = [];
    for (let i = 0; i < rawTokens.length; i++) {
      const tok = rawTokens[i];
      if (tok.length < 2 && !/^\d+$/.test(tok)) continue;
      if (STOPWORDS.has(tok)) continue;
      result.push(tok);
    }
    return result;
  }

  function scoreChunks(chunks, query, options = {}) {
    const list = Array.isArray(chunks) ? chunks : [];
    const queryTokens = normalizeSearchTokens(query || '');
    const targetTokens = normalizeSearchTokens(options.target || '');
    const allQueryTokens = Array.from(new Set([...queryTokens, ...targetTokens]));
    const normalizedQuery = cleanWhitespace(query || '').toLowerCase();

    return list
      .map((chunk, idx) => {
        const sectionLower = cleanWhitespace(chunk.section || '').toLowerCase();
        const textLower = cleanWhitespace(chunk.text || '').toLowerCase();
        let score = 0;

        if (normalizedQuery && normalizedQuery.length >= 4) {
          if (sectionLower.includes(normalizedQuery)) score += 10;
          if (textLower.includes(normalizedQuery)) score += 6;
        }

        for (let i = 0; i < allQueryTokens.length; i++) {
          const tok = allQueryTokens[i];
          if (sectionLower.includes(tok)) score += 4;
          if (textLower.includes(tok)) {
            score += 2;
            // Small boost for prefix/exact word boundary match
            if (textLower.split(/\s+/).some((w) => w.startsWith(tok))) {
              score += 1;
            }
          }
        }

        return {
          chunk,
          index: typeof chunk.index === 'number' ? chunk.index : idx,
          score
        };
      })
      .sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        return a.index - b.index;
      });
  }

  function selectTopChunks(digest, query, options = {}) {
    const chunks = (digest && Array.isArray(digest.chunks)) ? digest.chunks : [];
    if (chunks.length === 0) return [];

    const maxChunks = Math.max(1, Math.min(Number(options.maxChunks) || DEFAULT_MAX_CHUNKS, 3));
    const maxTokens = Math.max(100, Number(options.maxTokens) || DEFAULT_MAX_CHUNK_TOKENS);

    const scored = scoreChunks(chunks, query, options);
    const hasPositiveScore = scored.some((item) => item.score > 0);
    const orderedCandidates = hasPositiveScore
      ? scored
      : chunks.map((chunk, idx) => ({ chunk, index: idx, score: 0 }));

    const selected = [];
    let usedTokens = 0;

    for (let i = 0; i < orderedCandidates.length && selected.length < maxChunks; i++) {
      const candidate = orderedCandidates[i].chunk;
      const chunkHeader = `[${candidate.section}] `;
      const remaining = maxTokens - usedTokens;
      if (remaining < 40) break;

      const fullEntry = `${chunkHeader}${candidate.text}`;
      const tok = estimateTokens(fullEntry);
      if (tok <= remaining) {
        selected.push({
          ...candidate,
          score: orderedCandidates[i].score,
          text: candidate.text
        });
        usedTokens += tok;
      } else {
        const clippedText = truncateToTokenBudget(candidate.text, remaining - estimateTokens(chunkHeader));
        if (clippedText) {
          selected.push({
            ...candidate,
            score: orderedCandidates[i].score,
            text: clippedText
          });
          usedTokens += estimateTokens(`${chunkHeader}${clippedText}`);
        }
        break;
      }
    }

    return selected;
  }

  function formatElementsCompact(elements, maxTokens) {
    const list = Array.isArray(elements) ? elements : [];
    if (list.length === 0 || maxTokens <= 20) return '';

    const lines = [];
    let used = 0;
    for (let i = 0; i < list.length; i++) {
      const el = list[i];
      const tag = `[${el.id}|${el.type}|${el.label}]`;
      const cost = estimateTokens(tag + '\n');
      if (used + cost > maxTokens) break;
      lines.push(tag);
      used += cost;
    }
    return lines.join('\n');
  }

  function formatHeadingsCompact(headings, maxTokens) {
    const list = Array.isArray(headings) ? headings : [];
    if (list.length === 0 || maxTokens <= 15) return '';

    const lines = [];
    let used = 0;
    for (let i = 0; i < list.length; i++) {
      const h = list[i];
      const indent = '  '.repeat(Math.max(0, Math.min((h.level || 1) - 1, 3)));
      const line = `${indent}H${h.level || 2}: ${h.text}`;
      const cost = estimateTokens(line + '\n');
      if (used + cost > maxTokens) break;
      lines.push(line);
      used += cost;
    }
    return lines.join('\n');
  }

  function formatDigestForPrompt(digest, options = {}) {
    const d = digest || { title: 'Page', urlClean: '', headings: [], elements: [], chunks: [] };
    const maxTokens = Math.max(200, Number(options.maxTokens) || DEFAULT_CLOUD_DIGEST_TOKENS);
    const maxChunkTokens = Math.min(
      Number(options.maxChunkTokens) || DEFAULT_MAX_CHUNK_TOKENS,
      Math.max(120, Math.floor(maxTokens * 0.65))
    );
    const maxChunks = Math.max(1, Math.min(Number(options.maxChunks) || DEFAULT_MAX_CHUNKS, 3));
    const includeElements = options.includeElements !== false;

    const header = `TITLE: ${d.title || 'Page'}\nURL: ${d.urlClean || 'unknown'}`;
    let remaining = maxTokens - estimateTokens(header + '\n');

    const parts = [header];

    // Reserve budget ratios cleanly: headings (~15%), elements (~25%), chunks (~60%)
    const headingBudget = Math.min(Math.floor(maxTokens * 0.16), Math.max(0, remaining));
    const headingsBlock = formatHeadingsCompact(d.headings, headingBudget);
    if (headingsBlock) {
      const block = `HEADINGS:\n${headingsBlock}`;
      parts.push(block);
      remaining -= estimateTokens('\n' + block);
    }

    if (includeElements && remaining > 60) {
      const elementBudget = Math.min(Math.floor(maxTokens * 0.25), Math.floor(remaining * 0.4));
      const elementsBlock = formatElementsCompact(d.elements, elementBudget);
      if (elementsBlock) {
        const block = `ELEMENTS [id|type|label]:\n${elementsBlock}`;
        parts.push(block);
        remaining -= estimateTokens('\n' + block);
      }
    }

    if (remaining > 40) {
      const effectiveChunkBudget = Math.min(maxChunkTokens, remaining - 8);
      const selectedChunks = options.topChunksOnly
        ? selectTopChunks(d, options.query || options.target || '', {
            target: options.target || '',
            maxChunks,
            maxTokens: effectiveChunkBudget
          })
        : selectTopChunks(d, options.target || '', {
            target: options.target || '',
            maxChunks: Math.min(maxChunks, 3),
            maxTokens: effectiveChunkBudget
          });

      if (selectedChunks.length > 0) {
        const chunkLines = selectedChunks.map((c) => `[${c.id}|${c.section}] ${c.text}`);
        parts.push(`CHUNKS:\n${chunkLines.join('\n')}`);
      }
    }

    const joined = parts.join('\n');
    return truncateToTokenBudget(joined, maxTokens);
  }

  function collectHeadingElementsWithNodes(doc) {
    const out = [];
    if (!doc || typeof doc.querySelectorAll !== 'function') return out;
    const nodes = doc.querySelectorAll('h1, h2, h3, h4, h5, h6, [role="heading"]');
    for (let i = 0; i < nodes.length; i++) {
      const h = nodes[i];
      if (isInsideSleepwalker(h) || !isElementVisible(h, doc)) continue;
      const text = sanitizeUntrustedPageText(h.innerText || h.textContent || '');
      if (!text) continue;
      const tag = String(h.tagName || '').toUpperCase();
      const ariaLvl = Number(getAttributeSafe(h, 'aria-level') || 0);
      const level = /^H[1-6]$/.test(tag) ? Number(tag.slice(1)) : (ariaLvl >= 1 && ariaLvl <= 6 ? ariaLvl : 2);
      out.push({ node: h, level, text: text.slice(0, 120) });
    }
    return out;
  }

  function buildHeadingHierarchy(headingEntries) {
    const stack = [];
    const subCounters = new Map();
    return (headingEntries || []).map((entry, idx) => {
      const lvl = entry.level || 2;
      while (stack.length > 0 && stack[stack.length - 1].level >= lvl) {
        stack.pop();
      }
      const parent = stack.length > 0 ? stack[stack.length - 1] : null;
      const parentKey = parent ? `${parent.id}:${parent.text}` : '__root__';
      const subIdx = (subCounters.get(parentKey) || 0) + 1;
      subCounters.set(parentKey, subIdx);
      const path = stack.map((s) => s.text).concat(entry.text);
      const item = {
        id: `h${idx + 1}`,
        level: lvl,
        text: entry.text,
        parentSection: parent ? parent.text : '',
        parentId: parent ? parent.id : '',
        subsectionIndex: subIdx,
        sectionPath: path,
        sectionPathText: path.join(' > '),
        node: entry.node
      };
      stack.push(item);
      return item;
    });
  }

  function findEnclosingSectionMeta(el, hierarchy) {
    if (!el || !Array.isArray(hierarchy) || hierarchy.length === 0) {
      return { section: '', sectionPath: [], sectionPathText: '' };
    }
    // Find nearest preceding heading in document order via compareDocumentPosition when supported
    let matched = null;
    if (typeof el.compareDocumentPosition === 'function') {
      for (let i = 0; i < hierarchy.length; i++) {
        const h = hierarchy[i];
        if (!h.node || typeof h.node.compareDocumentPosition !== 'function') continue;
        if (h.node === el || (h.node.contains && h.node.contains(el))) {
          matched = h;
          break;
        }
        const rel = h.node.compareDocumentPosition(el);
        // DOCUMENT_POSITION_FOLLOWING = 4
        if ((rel & 4) !== 0) {
          matched = h;
        }
      }
    }
    if (matched) {
      return {
        section: matched.text,
        sectionPath: matched.sectionPath || [matched.text],
        sectionPathText: matched.sectionPathText || matched.text
      };
    }
    return { section: '', sectionPath: [], sectionPathText: '' };
  }

  function collectStructuredTables(doc, hierarchy = []) {
    if (!doc || typeof doc.querySelectorAll !== 'function') return [];
    const tableNodes = doc.querySelectorAll('table');
    const tables = [];

    for (let tIdx = 0; tIdx < tableNodes.length && tables.length < 6; tIdx++) {
      const tbl = tableNodes[tIdx];
      if (isInsideSleepwalker(tbl) || !isElementVisible(tbl, doc)) continue;
      if (tbl.closest && tbl.closest('nav, footer')) continue;

      const capEl = tbl.querySelector ? tbl.querySelector('caption') : null;
      const caption = capEl ? sanitizeUntrustedPageText(capEl.innerText || capEl.textContent || '').slice(0, 90) : '';
      const secMeta = findEnclosingSectionMeta(tbl, hierarchy);
      const sectionName = caption || secMeta.section || `Table ${tables.length + 1}`;

      const rowsRaw = Array.from(tbl.querySelectorAll ? tbl.querySelectorAll('tr') : []);
      if (rowsRaw.length === 0) continue;

      let headers = [];
      let bodyStartIdx = 0;
      const theadHeaders = tbl.querySelectorAll ? Array.from(tbl.querySelectorAll('thead th, thead td')) : [];
      if (theadHeaders.length > 0) {
        headers = theadHeaders.slice(0, 8).map((c, idx) => sanitizeUntrustedPageText(c.innerText || c.textContent || '') || `Column ${idx + 1}`);
      } else {
        const firstCells = Array.from(rowsRaw[0].querySelectorAll ? rowsRaw[0].querySelectorAll('th, td') : []);
        const hasTh = rowsRaw[0].querySelectorAll && rowsRaw[0].querySelectorAll('th').length > 0;
        if (hasTh && firstCells.length > 0) {
          headers = firstCells.slice(0, 8).map((c, idx) => sanitizeUntrustedPageText(c.innerText || c.textContent || '') || `Column ${idx + 1}`);
          bodyStartIdx = 1;
        }
      }

      const rows = [];
      for (let r = bodyStartIdx; r < rowsRaw.length && rows.length < 18; r++) {
        const tr = rowsRaw[r];
        if (!isElementVisible(tr, doc)) continue;
        const cells = Array.from(tr.querySelectorAll ? tr.querySelectorAll('th, td') : []);
        if (cells.length === 0) continue;

        const rawCells = [];
        const keyed = {};
        const rowLinks = [];
        for (let c = 0; c < cells.length && c < 8; c++) {
          const cell = cells[c];
          const val = sanitizeUntrustedPageText(cell.innerText || cell.textContent || '').slice(0, 90);
          rawCells.push(val);
          const colName = headers[c] || `Column ${c + 1}`;
          keyed[colName] = val;
          if (cell.querySelectorAll) {
            const links = cell.querySelectorAll('a[href]');
            for (let li = 0; li < links.length; li++) {
              const a = links[li];
              const lbl = sanitizeUntrustedPageText(a.innerText || a.textContent || '').slice(0, 60);
              if (lbl) rowLinks.push({ label: lbl, href: cleanWhitespace(getAttributeSafe(a, 'href') || ''), column: colName });
            }
          }
        }
        const nonEmpty = rawCells.filter(Boolean);
        if (nonEmpty.length === 0) continue;
        rows.push({
          rowIndex: rows.length + 1,
          headers: headers.length ? headers : rawCells.map((_, idx) => `Column ${idx + 1}`),
          cells: keyed,
          rawCells,
          rowSummary: headers.length
            ? headers.map((h, i) => (rawCells[i] ? `${h}: ${rawCells[i]}` : '')).filter(Boolean).join(', ')
            : nonEmpty.join(' | '),
          links: rowLinks
        });
      }

      if (rows.length > 0) {
        tables.push({
          id: `table_${tables.length + 1}`,
          caption,
          section: sectionName,
          sectionPath: secMeta.sectionPath,
          headers,
          rows
        });
      }
    }
    return tables;
  }

  function parseDurationToSeconds(raw) {
    const str = cleanWhitespace(String(raw || ''));
    if (!str) return null;
    const colon = str.match(/^(\d+):([0-5]?\d)(?::([0-5]?\d))?$/);
    if (colon) {
      if (colon[3] !== undefined) {
        return Number(colon[1]) * 3600 + Number(colon[2]) * 60 + Number(colon[3]);
      }
      return Number(colon[1]) * 60 + Number(colon[2]);
    }
    const minMatch = str.match(/(\d+)\s*(?:min|minute|minutes|m)\b/i);
    const secMatch = str.match(/(\d+)\s*(?:sec|second|seconds|s)\b/i);
    if (minMatch || secMatch) {
      return (minMatch ? Number(minMatch[1]) * 60 : 0) + (secMatch ? Number(secMatch[1]) : 0);
    }
    return null;
  }

  function formatTimestampSeconds(sec) {
    const s = Math.max(0, Math.floor(Number(sec) || 0));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const rem = s % 60;
    const mm = h > 0 ? String(m).padStart(2, '0') : String(m);
    const ss = String(rem).padStart(2, '0');
    return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
  }

  function extractYouTubeVideoId(urlStr = '') {
    const raw = String(urlStr || '');
    const vMatch = raw.match(/[?&]v=([A-Za-z0-9_-]{6,})/);
    if (vMatch) return vMatch[1];
    const shortMatch = raw.match(/(?:youtu\.be\/|\/shorts\/|\/embed\/)([A-Za-z0-9_-]{6,})/);
    if (shortMatch) return shortMatch[1];
    return '';
  }

  function extractYouTubeTranscriptSegments(doc) {
    if (!doc) return { captionsAvailable: false, segments: [], source: 'none', reason: 'No document loaded.' };
    const segments = [];
    const pushSegment = (startSec, text, timestamp = '') => {
      const clean = sanitizeUntrustedPageText(text).slice(0, 260);
      if (!clean) return;
      const numericStart = Number.isFinite(Number(startSec))
        ? Math.max(0, Number(startSec))
        : (parseDurationToSeconds(timestamp) ?? 0);
      segments.push({
        startSec: numericStart,
        timestamp: timestamp || formatTimestampSeconds(numericStart),
        text: clean
      });
    };

    // 1. Live or fixture DOM transcript panels (supports legacy ytd-transcript-segment-renderer & 2026 transcript-segment-view-model)
    if (typeof doc.querySelectorAll === 'function') {
      const segNodes = doc.querySelectorAll('transcript-segment-view-model, .ytwTranscriptSegmentViewModelHost, ytd-transcript-segment-renderer, [data-transcript-segment], .transcript-segment');
      for (let i = 0; i < segNodes.length && segments.length < 300; i++) {
        const node = segNodes[i];
        const tsEl = node.querySelector && node.querySelector('.ytwTranscriptSegmentViewModelTimestamp, .segment-timestamp, [data-timestamp], .timestamp');
        const txtEl = node.querySelector && node.querySelector('span.ytAttributedStringHost, span[role="text"], .yt-core-attributed-string, .segment-text, yt-formatted-string.segment-text, .caption-text, .text');
        const tsText = cleanWhitespace((node.getAttribute && (node.getAttribute('data-timestamp') || node.getAttribute('data-start'))) || (tsEl && (tsEl.innerText || tsEl.textContent)) || '');
        const startAttr = node.getAttribute ? (node.getAttribute('data-start-sec') || node.getAttribute('data-start')) : null;
        const bodyText = txtEl ? (txtEl.innerText || txtEl.textContent || '') : (node.innerText || node.textContent || '').replace(tsText, '').trim();
        pushSegment(startAttr !== null ? Number(startAttr) : undefined, bodyText, tsText);
      }
      if (segments.length > 0) {
        return { captionsAvailable: true, segments, source: 'dom_transcript', reason: '' };
      }

      // 2. Fixture/embedded JSON caption script (#sw-yt-captions or [data-captions-json])
      const capScript = doc.querySelector('#sw-yt-captions, script[data-sw-captions], [data-captions-json]');
      if (capScript) {
        const rawJson = (capScript.getAttribute && capScript.getAttribute('data-captions-json')) || capScript.textContent || '';
        if (rawJson.trim()) {
          try {
            const parsed = JSON.parse(rawJson);
            const list = Array.isArray(parsed) ? parsed : (Array.isArray(parsed.segments) ? parsed.segments : []);
            for (let i = 0; i < list.length && segments.length < 300; i++) {
              const item = list[i];
              if (!item || typeof item !== 'object') continue;
              pushSegment(item.startSec ?? item.start ?? item.t, item.text || item.utf8 || '', item.timestamp || '');
            }
            if (segments.length > 0) {
              return { captionsAvailable: true, segments, source: 'embedded_captions', reason: '' };
            }
          } catch (_e) {}
        }
      }

      // 3. HTML5 <video>.textTracks cues
      const videoEl = doc.querySelector('video');
      if (videoEl && videoEl.textTracks && videoEl.textTracks.length > 0) {
        for (let t = 0; t < videoEl.textTracks.length; t++) {
          const track = videoEl.textTracks[t];
          const cues = track && track.cues ? Array.from(track.cues) : [];
          for (let c = 0; c < cues.length && segments.length < 300; c++) {
            const cue = cues[c];
            if (cue && cue.text) pushSegment(cue.startTime, cue.text, formatTimestampSeconds(cue.startTime));
          }
          if (segments.length > 0) {
            return { captionsAvailable: true, segments, source: 'video_text_track', reason: '' };
          }
        }
      }
    }

    return {
      captionsAvailable: false,
      segments: [],
      source: 'none',
      reason: 'No captions or transcript are available on this video page.'
    };
  }

  function sliceAndGroupTranscript(segments, options = {}) {
    const list = Array.isArray(segments) ? segments.filter((s) => s && s.text) : [];
    if (list.length === 0) return { segments: [], topics: [], combinedText: '' };

    const startSec = Number.isFinite(Number(options.startMinutes)) && Number(options.startMinutes) > 0
      ? Number(options.startMinutes) * 60
      : 0;
    const endSec = Number.isFinite(Number(options.maxMinutes)) && Number(options.maxMinutes) > 0
      ? Number(options.maxMinutes) * 60
      : Infinity;

    const filtered = list.filter((s) => (Number(s.startSec) || 0) >= startSec && (Number(s.startSec) || 0) <= endSec);
    const active = filtered.length > 0 ? filtered : (endSec < Infinity ? [] : list);
    if (active.length === 0) {
      return { segments: [], topics: [], combinedText: '' };
    }

    const bucketCount = Math.min(4, Math.max(1, Math.ceil(active.length / 4)));
    const bucketSize = Math.ceil(active.length / bucketCount);
    const topics = [];
    for (let i = 0; i < active.length; i += bucketSize) {
      const slice = active.slice(i, i + bucketSize);
      const fromTs = slice[0].timestamp || formatTimestampSeconds(slice[0].startSec);
      const toTs = slice[slice.length - 1].timestamp || formatTimestampSeconds(slice[slice.length - 1].startSec);
      topics.push({
        index: topics.length + 1,
        startSec: slice[0].startSec,
        title: `${fromTs} - ${toTs}`,
        text: slice.map((x) => x.text).join(' ')
      });
    }

    const combinedText = active.map((s) => `[${s.timestamp || formatTimestampSeconds(s.startSec)}] ${s.text}`).join('\n');
    return { segments: active, topics, combinedText };
  }

  function extractYouTubePageContext(doc) {
    if (!doc || typeof doc.querySelectorAll !== 'function') {
      return { isYouTube: false, pageKind: 'none', videos: [], watchVideo: null };
    }
    const href = (doc.location && doc.location.href) || '';
    const hostname = (doc.location && doc.location.hostname) || '';
    const ytMarker = (doc.documentElement && getAttributeSafe(doc.documentElement, 'data-sw-site'))
      || (doc.body && getAttributeSafe(doc.body, 'data-sw-site'))
      || '';
    const hasYtEls = Boolean(
      doc.querySelector('ytd-video-renderer, ytd-rich-item-renderer, ytd-compact-video-renderer, .yt-lockup-view-model, [data-video-id], .video-card[data-channel]')
    );
    const isYouTube = /(?:^|\.)youtube\.com$|youtu\.be$/i.test(hostname) || /^youtube/i.test(ytMarker) || hasYtEls;
    if (!isYouTube) {
      return { isYouTube: false, pageKind: 'none', videos: [], watchVideo: null };
    }

    const videos = [];
    const seenKeys = new Set();
    const combinedCardSelector = [
      'ytd-video-renderer',
      'ytd-rich-item-renderer',
      'ytd-compact-video-renderer',
      '.yt-lockup-view-model',
      'yt-lockup-view-model',
      '[data-video-card]',
      '.video-card',
      'article[data-video-id]',
      '[data-video-id]'
    ].join(', ');

    const cards = doc.querySelectorAll(combinedCardSelector);
    for (let i = 0; i < cards.length && videos.length < 60; i++) {
      const card = cards[i];
      if (isInsideSleepwalker(card) || !isElementVisible(card, doc)) continue;
      const titleEl = (card.querySelector && card.querySelector('#video-title, h3 a, a.yt-lockup-metadata-view-model__title, h3, .video-title, [data-video-title], a[title]')) || card;
      const linkEl = (card.querySelector && card.querySelector('a#video-title[href], h3 a[href], a[href*="/watch"], a[href*="/shorts/"], a#thumbnail[href], a[href]')) || (card.tagName === 'A' ? card : null);
      const title = sanitizeUntrustedPageText(
        (card.getAttribute && card.getAttribute('data-title'))
        || (titleEl && (titleEl.getAttribute && (titleEl.getAttribute('title') || titleEl.getAttribute('aria-label'))))
        || (titleEl && (titleEl.innerText || titleEl.textContent))
        || ''
      ).slice(0, 130);
      if (!title || title.length < 2) continue;

      const channelEl = card.querySelector && card.querySelector('ytd-channel-name #text, ytd-channel-name a, #channel-name a, #channel-name, [data-channel], .video-channel, .channel-name');
      const channel = sanitizeUntrustedPageText(
        (card.getAttribute && card.getAttribute('data-channel'))
        || (channelEl && (channelEl.innerText || channelEl.textContent))
        || ''
      ).slice(0, 70);

      const durEl = card.querySelector && card.querySelector('ytd-thumbnail-overlay-time-status-renderer #text, .yt-badge-shape__text, [data-duration], .video-duration, .duration');
      const duration = cleanWhitespace(
        (card.getAttribute && card.getAttribute('data-duration'))
        || (durEl && (durEl.innerText || durEl.textContent))
        || ''
      ).slice(0, 24);
      const durationSeconds = parseDurationToSeconds(duration);

      const descEl = card.querySelector && card.querySelector('#description-text, .metadata-snippet-text, [data-description], .video-description, p');
      const description = sanitizeUntrustedPageText(
        (card.getAttribute && card.getAttribute('data-description'))
        || (descEl && (descEl.innerText || descEl.textContent))
        || ''
      ).slice(0, 180);

      const viewsEl = card.querySelector && card.querySelector('#metadata-line span, .video-views, [data-views]');
      const views = cleanWhitespace((card.getAttribute && card.getAttribute('data-views')) || (viewsEl && (viewsEl.innerText || viewsEl.textContent)) || '').slice(0, 40);

      const cardHref = linkEl ? (getAttributeSafe(linkEl, 'href') || linkEl.href || '') : '';
      const videoId = (card.getAttribute && card.getAttribute('data-video-id')) || extractYouTubeVideoId(cardHref) || `v_${videos.length + 1}`;
      const dedupKey = `${title.toLowerCase()}::${channel.toLowerCase()}`;
      if (seenKeys.has(dedupKey)) continue;
      seenKeys.add(dedupKey);

      videos.push({
        id: `video_${videos.length + 1}`,
        index: videos.length + 1,
        videoId,
        title,
        channel,
        duration,
        durationSeconds,
        views,
        description,
        url: cardHref,
        href: cardHref,
        entityType: 'video',
        element: linkEl || titleEl || card
      });
    }

    const isRealYtDomain = /(?:^|\.)youtube\.com$|youtu\.be$/i.test(hostname);
    const ytWatchUrl = /[?&]v=/.test(href) || /\/(?:watch|shorts)(?:\/|\?|$)/i.test(href);
    const isWatchPage = ytWatchUrl
      || (!isRealYtDomain && Boolean(doc.querySelector('ytd-watch-flexy, #movie_player')))
      || Boolean(doc.querySelector('[data-yt-watch], video[data-video-title]'))
      || String(getAttributeSafe(doc.body || doc.documentElement, 'data-yt-page') || '').toLowerCase() === 'watch';

    let watchVideo = null;
    if (isWatchPage) {
      const videoEl = doc.querySelector('video');
      const titleNode = doc.querySelector('ytd-watch-metadata h1, #above-the-fold #title h1, h1.ytd-watch-metadata, [data-watch-title], h1');
      const chanNode = doc.querySelector('ytd-watch-metadata ytd-channel-name #text, #owner #channel-name a, [data-watch-channel], .watch-channel');
      const descNode = doc.querySelector('ytd-watch-metadata #description-inline-expander, #description-inner, #description, [data-watch-description], .watch-description');
      const watchTitle = sanitizeUntrustedPageText(
        (videoEl && getAttributeSafe(videoEl, 'data-video-title'))
        || (titleNode && (titleNode.innerText || titleNode.textContent))
        || doc.title || ''
      ).replace(/\s*-\s*YouTube$/i, '').slice(0, 140);
      const watchChannel = sanitizeUntrustedPageText(
        (videoEl && getAttributeSafe(videoEl, 'data-channel'))
        || (chanNode && (chanNode.innerText || chanNode.textContent))
        || ''
      ).slice(0, 80);
      const watchDesc = sanitizeUntrustedPageText(descNode ? (descNode.innerText || descNode.textContent || '') : '').slice(0, 420);
      const transcriptInfo = extractYouTubeTranscriptSegments(doc);
      const rawDur = videoEl && Number.isFinite(videoEl.duration) && videoEl.duration > 0
        ? formatTimestampSeconds(videoEl.duration)
        : (cleanWhitespace(getAttributeSafe(videoEl || doc.body, 'data-duration') || ''));

      watchVideo = {
        videoId: extractYouTubeVideoId(href) || getAttributeSafe(videoEl || doc.body, 'data-video-id') || 'watch_current',
        title: watchTitle,
        channel: watchChannel,
        duration: rawDur,
        durationSeconds: (videoEl && Number.isFinite(videoEl.duration) && videoEl.duration > 0)
          ? Math.round(videoEl.duration)
          : parseDurationToSeconds(rawDur),
        description: watchDesc,
        paused: videoEl ? Boolean(videoEl.paused) : null,
        muted: videoEl ? Boolean(videoEl.muted) : null,
        currentTime: videoEl && Number.isFinite(videoEl.currentTime) ? Math.round(videoEl.currentTime) : 0,
        hasVideoElement: Boolean(videoEl),
        captionsAvailable: transcriptInfo.captionsAvailable,
        captionsReason: transcriptInfo.reason,
        transcriptSource: transcriptInfo.source,
        transcriptSegments: transcriptInfo.segments
      };
    }

    const pageKind = isWatchPage ? 'youtube_watch' : (/[?&]search_query=/.test(href) || String(ytMarker).includes('search') ? 'youtube_search' : 'youtube_feed');
    return { isYouTube: true, pageKind, videos, watchVideo };
  }

  function inferPageType(doc, urlClean, headings, stats = {}) {
    const yt = stats.youtube;
    if (yt && yt.isYouTube) return yt.pageKind;
    const u = String(urlClean || '').toLowerCase();
    const docEl = doc && doc.documentElement;
    const explicitType = doc && doc.body ? cleanWhitespace(getAttributeSafe(doc.body, 'data-sw-page-type') || getAttributeSafe(docEl, 'data-sw-page-type') || '').toLowerCase() : '';
    if (explicitType) return explicitType;
    if (/wikipedia\.org\//.test(u) || (doc && doc.querySelector && doc.querySelector('.mw-parser-output, #mw-content-text'))) {
      return 'wikipedia';
    }
    if (/(?:docs\.|\/docs(?:\/|$)|\/documentation|\/api(?:\/|$)|\/reference|pytorch\.org\/docs|developer\.)/.test(u)
      || (doc && doc.querySelector && doc.querySelector('.sphinxsidebar, .markdown-body h1, article .highlight'))) {
      return 'documentation';
    }
    if (stats.tableCount > 0 && stats.headingCount <= 8) return 'table_data';
    if (stats.hasForm && stats.headingCount <= 6) return 'form';
    if ((headings || []).length >= 3) return 'article';
    return 'general';
  }

  function buildStructuredPageContext(doc, options = {}) {
    const targetDoc = doc || (typeof document !== 'undefined' ? document : null);
    const baseDigest = buildDigest(targetDoc, options);
    const rawHeadings = collectHeadingElementsWithNodes(targetDoc);
    const hierarchy = buildHeadingHierarchy(rawHeadings);
    const tables = collectStructuredTables(targetDoc, hierarchy);
    const youtube = extractYouTubePageContext(targetDoc);

    let website = '';
    try {
      const rawLoc = (targetDoc && targetDoc.location && targetDoc.location.href) || baseDigest.urlClean;
      if (rawLoc && /^https?:/i.test(rawLoc)) website = new URL(rawLoc).hostname;
    } catch (_e) {}

    const links = [];
    if (targetDoc && typeof targetDoc.querySelectorAll === 'function') {
      const anchors = targetDoc.querySelectorAll('a[href], button, [role="link"], [role="button"]');
      for (let i = 0; i < anchors.length && links.length < 45; i++) {
        const el = anchors[i];
        if (isInsideSleepwalker(el) || !isElementVisible(el, targetDoc)) continue;
        const label = sanitizeUntrustedPageText(resolveInteractiveLabel(el, targetDoc)).slice(0, 90);
        if (!label) continue;
        const secMeta = findEnclosingSectionMeta(el, hierarchy);
        const rawHref = getAttributeSafe(el, 'href') || '';
        let domain = '';
        let resolvedHref = rawHref;
        try {
          const base = (targetDoc.location && targetDoc.location.href) || undefined;
          if (rawHref) {
            const u = new URL(rawHref, base);
            resolvedHref = u.href;
            domain = u.hostname || '';
          }
        } catch (_e) {}

        const isOfficial = /\.(?:gov|edu|ac\.[a-z]{2}|org)$|^(?:docs|developer|api)\.|pytorch\.org|python\.org|mozilla\.org/i.test(domain)
          || /\b(?:official|docs|documentation)\b/i.test(label);

        links.push({
          id: `link_${links.length + 1}`,
          type: classifyInteractiveElement(el),
          label,
          section: secMeta.section,
          sectionPath: secMeta.sectionPath,
          sectionPathText: secMeta.sectionPathText,
          href: resolvedHref,
          domain,
          official: isOfficial
        });
      }
    }

    const searchFields = [];
    if (targetDoc && typeof targetDoc.querySelectorAll === 'function') {
      const inputs = targetDoc.querySelectorAll('input[type="search"], input[type="text"], input:not([type]), [role="searchbox"]');
      for (let i = 0; i < inputs.length && searchFields.length < 10; i++) {
        const inp = inputs[i];
        if (isInsideSleepwalker(inp) || !isElementVisible(inp, targetDoc)) continue;
        const lbl = sanitizeUntrustedPageText(resolveInteractiveLabel(inp, targetDoc)).slice(0, 80);
        if (isSensitiveField(inp, lbl)) continue;
        const role = String(getAttributeSafe(inp, 'role') || '').toLowerCase();
        const type = String(getAttributeSafe(inp, 'type') || 'text').toLowerCase();
        const looksSearch = type === 'search' || role === 'searchbox'
          || /\bsearch|find|lookup|query|filter\b/i.test(`${lbl} ${getAttributeSafe(inp, 'placeholder') || ''} ${getAttributeSafe(inp, 'name') || ''}`);
        if (!looksSearch) continue;
        const secMeta = findEnclosingSectionMeta(inp, hierarchy);
        searchFields.push({
          id: `search_${searchFields.length + 1}`,
          label: lbl || 'Search',
          section: secMeta.section
        });
      }
    }

    const formsCount = targetDoc && targetDoc.querySelectorAll ? targetDoc.querySelectorAll('form').length : 0;
    const pageType = inferPageType(targetDoc, baseDigest.urlClean, hierarchy, {
      youtube,
      tableCount: tables.length,
      headingCount: hierarchy.length,
      hasForm: formsCount > 0
    });

    const cleanHeadings = hierarchy.map(({ node, ...rest }) => rest);

    return {
      website: website || 'local',
      url: baseDigest.urlClean,
      urlClean: baseDigest.urlClean,
      title: baseDigest.title,
      pageType,
      pageTextHash: baseDigest.pageTextHash,
      mainHeadings: cleanHeadings.slice(0, 14),
      sections: cleanHeadings,
      links,
      tables: tables.map((t) => ({
        id: t.id,
        caption: t.caption,
        section: t.section,
        headers: t.headers,
        rows: t.rows.slice(0, 12).map((r) => ({
          rowIndex: r.rowIndex,
          rowSummary: r.rowSummary,
          cells: r.cells,
          links: r.links
        }))
      })),
      videos: youtube.videos.map(({ element, ...rest }) => rest),
      watchVideo: youtube.watchVideo,
      searchFields,
      chunks: baseDigest.chunks,
      elements: baseDigest.elements,
      fullSafeText: baseDigest.fullSafeText
    };
  }

  function formatStructuredContextForNlu(ctx, options = {}) {
    if (!ctx || typeof ctx !== 'object') return '';
    const maxTokens = Math.max(240, Number(options.maxTokens) || 750);
    const lines = [
      `PAGE_TYPE: ${ctx.pageType || 'general'} | SITE: ${ctx.website || 'local'}`,
      `TITLE: ${ctx.title || 'Page'}`,
      `URL: ${ctx.urlClean || ctx.url || 'unknown'}`
    ];

    if (ctx.watchVideo) {
      const w = ctx.watchVideo;
      lines.push(`WATCH_VIDEO: "${w.title}" | channel: ${w.channel || 'unknown'} | duration: ${w.duration || 'unknown'} | paused: ${w.paused} | captions: ${w.captionsAvailable ? 'available' : 'unavailable'}`);
      if (w.description) lines.push(`VIDEO_DESC: ${w.description.slice(0, 180)}`);
    }

    if (Array.isArray(ctx.videos) && ctx.videos.length > 0) {
      lines.push('VIDEOS:');
      ctx.videos.slice(0, 8).forEach((v) => {
        lines.push(`${v.id} | ${v.title} | ch:${v.channel || '-'} | dur:${v.duration || '-'} | desc:${(v.description || '').slice(0, 70)}`);
      });
    }

    if (Array.isArray(ctx.mainHeadings) && ctx.mainHeadings.length > 0) {
      lines.push('HEADINGS:');
      ctx.mainHeadings.slice(0, 10).forEach((h) => {
        lines.push(`H${h.level} [${h.sectionPathText || h.text}]`);
      });
    }

    if (Array.isArray(ctx.links) && ctx.links.length > 0) {
      lines.push('LINKS:');
      ctx.links.slice(0, 16).forEach((l) => {
        const sec = l.sectionPathText || l.section || 'page';
        const tag = l.official ? 'official' : (l.domain || l.type);
        lines.push(`${l.id} | ${l.label} | sec:${sec.slice(0, 40)} | ${tag}`);
      });
    }

    if (Array.isArray(ctx.tables) && ctx.tables.length > 0) {
      lines.push('TABLES:');
      ctx.tables.slice(0, 2).forEach((t) => {
        lines.push(`${t.id} (${t.section}): headers=[${(t.headers || []).join(', ')}]`);
        (t.rows || []).slice(0, 5).forEach((r) => {
          lines.push(`  row_${r.rowIndex}: ${r.rowSummary.slice(0, 120)}`);
        });
      });
    }

    if (Array.isArray(ctx.searchFields) && ctx.searchFields.length > 0) {
      lines.push(`SEARCH_FIELDS: ${ctx.searchFields.map((s) => `${s.id}:${s.label}`).join('; ')}`);
    }

    return truncateToTokenBudget(lines.join('\n'), maxTokens);
  }

  return {
    DEFAULT_CLOUD_DIGEST_TOKENS,
    DEFAULT_OLLAMA_DIGEST_TOKENS,
    DEFAULT_MAX_CHUNK_TOKENS,
    DEFAULT_MAX_CHUNKS,
    estimateTokens,
    truncateToTokenBudget,
    hashText,
    normalizeNumerals,
    cleanWhitespace,
    sanitizeUntrustedPageText,
    isPrivateMessageArea,
    getCleanUrl,
    normalizeSearchTokens,
    buildDigest,
    buildStructuredPageContext,
    formatStructuredContextForNlu,
    extractYouTubePageContext,
    extractYouTubeTranscriptSegments,
    sliceAndGroupTranscript,
    collectStructuredTables,
    parseDurationToSeconds,
    formatTimestampSeconds,
    scoreChunks,
    selectTopChunks,
    formatDigestForPrompt
  };
});
