/**
 * Sleepwalker — Natural Voice Pipeline (Speakable Text, Sentence Chunker & Content-Based Echo Suppression)
 *
 * Adapted from MIT-licensed voice pipeline patterns (pushkar-env/cosmos_assistant):
 * - toSpeakable(): Strips <think> tags, markdown syntax, code fences, bare URLs & emojis before TTS.
 * - pauseAfterMs() & SentenceChunker: Human-paced sentence chunking supporting English & Hindi (।/॥).
 * - EchoTracker: Content-based echo suppression so Sleepwalker's own TTS never false-triggers its mic
 *   while allowing genuine user barge-in speech to pass through cleanly.
 */
(function (rootScope) {
  'use strict';

  if (rootScope.SleepwalkerVoicePipeline) return;

  const EMOJI_RE = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}\u{FE00}-\u{FE0F}\u{200D}]/gu;

  function toSpeakable(text) {
    return String(text || '')
      .replace(/<think>[\s\S]*?<\/think>/gi, ' ')
      .replace(/<\/?think>/gi, ' ')
      .replace(/```[\s\S]*?```/g, ' Code block omitted. ')
      .replace(/`([^`]+)`/g, '$1')
      .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      .replace(/https?:\/\/\S+/g, 'link')
      .replace(/^\s{0,3}#{1,6}\s+/gm, '')
      .replace(/^\s*>\s?/gm, '')
      .replace(/^(\s*(?:[-*+•]|\d+[.)])\s+[^\n]*[^\s.!?,;:…])$/gm, '$1.')
      .replace(/^\s*[-*+•]\s+/gm, '')
      .replace(/^\s*\d+\.\s+/gm, '')
      .replace(/^\s*\|.*\|\s*$/gm, ' ')
      .replace(/[*_~]{1,3}([^*_~]+)[*_~]{1,3}/g, '$1')
      .replace(/[*_#>|`~]+/g, ' ')
      .replace(EMOJI_RE, '')
      .replace(/[ \t]+/g, ' ')
      .replace(/\n{2,}/g, '. ')
      .replace(/([^\s.!?,;:…—–-])\n/g, '$1,\n')
      .replace(/\n/g, ' ')
      .replace(/\s+([.,!?;:])/g, '$1')
      .replace(/([.!?])\s*\.+/g, '$1')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function pauseAfterMs(raw, boundary = 'sentence') {
    const text = String(raw || '').trimEnd();
    let base = 240;
    if (boundary === 'paragraph') base = 650;
    else if (/^\s{0,3}#{1,6}\s/.test(raw)) base = 550;
    else if (boundary === 'line') base = 320;
    else {
      const bare = text.replace(/["')\]]+$/, '');
      if (bare.endsWith('...') || bare.endsWith('…')) base = 600;
      else {
        const last = bare.slice(-1);
        if (last === '?') base = 480;
        else if (last === '!') base = 410;
        else if (last === '।' || last === '॥' || last === '.') base = 360;
        else if (last === ':') base = 300;
        else if (last === ';') base = 280;
        else if (last === ',') base = 190;
      }
    }
    const words = text.split(/\s+/).filter(Boolean).length;
    const scaled = base + Math.min(150, words * 5);
    return Math.round(scaled * (0.85 + Math.random() * 0.3));
  }

  function chunkForSpeech(rawText, { firstMinChars = 24, nextMinChars = 60 } = {}) {
    const clean = toSpeakable(rawText);
    if (!clean) return [];
    const sentences = clean.split(/(?<=[.!?।॥])\s+/).filter(Boolean);
    const out = [];
    let buf = '';
    for (const s of sentences) {
      const minLen = out.length === 0 ? firstMinChars : nextMinChars;
      buf = buf ? `${buf} ${s}` : s;
      if (buf.length >= minLen) {
        out.push({ text: buf, pauseMs: pauseAfterMs(buf, 'sentence') });
        buf = '';
      }
    }
    if (buf) out.push({ text: buf, pauseMs: pauseAfterMs(buf, 'flush') });
    return out;
  }

  function tokenize(s) {
    return String(s || '')
      .toLowerCase()
      .replace(/[।॥.!?,;:"'“”‘’()\-–—]/g, ' ')
      .split(/\s+/)
      .filter(Boolean);
  }

  class EchoTracker {
    constructor(windowMs = 3500) {
      this.windowMs = windowMs;
      this.spoken = []; // [{ phrase: string, words: string[], ts: number }]
    }

    note(text) {
      const toks = tokenize(toSpeakable(text));
      if (toks.length === 0) return;
      const now = Date.now();
      this.spoken.push({ phrase: toks.join(' '), words: toks, ts: now });
      this.spoken = this.spoken.filter((e) => now - e.ts <= this.windowMs);
    }

    isEcho(transcript) {
      const now = Date.now();
      this.spoken = this.spoken.filter((e) => now - e.ts <= this.windowMs);
      const tokens = tokenize(transcript);
      if (tokens.length === 0 || this.spoken.length === 0) return false;
      const normPhrase = tokens.join(' ');
      // Only suppress genuine acoustic feedback: must match a contiguous spoken phrase within the active TTS reverb window.
      // Never suppress single/short command words via unordered bag-of-words overlap.
      for (const e of this.spoken) {
        const age = now - e.ts;
        if (age > this.windowMs) continue;
        if (e.phrase === normPhrase && age <= 2500) return true;
        if (tokens.length >= 3 && age <= 2500 && e.phrase.includes(normPhrase)) return true;
      }
      return false;
    }

    clear() {
      this.spoken = [];
    }
  }

  rootScope.SleepwalkerVoicePipeline = {
    toSpeakable,
    pauseAfterMs,
    chunkForSpeech,
    EchoTracker
  };
})(typeof self !== 'undefined' ? self : (typeof window !== 'undefined' ? window : globalThis));
