/**
 * Sleepwalker - intent.js
 * Natural Voice & Typed Command Intent Engine (EN / HI / Hinglish + regional LLM fallback).
 *
 * Pipeline:
 *   raw transcript
 *     -> normalise (Devanagari digits -> ASCII, case folding, Hinglish spelling variants, filler stripping)
 *     -> rule matcher (using lexicon.json synonyms & structured patterns)
 *     -> if confidence < 0.75: ONE compact LLM call via service worker returning JSON {intent, args, lang, confidence}
 */

(function (rootScope) {
  'use strict';

  const VALID_INTENTS = new Set([
    'SEARCH',
    'EXPLAIN',
    'READ',
    'ANSWER',
    'NAVIGATE',
    'FILL_GUIDED',
    'DICTATE',
    'FILL_PROFILE',
    'UPLOAD',
    'CONFIRM_YES',
    'CONFIRM_NO',
    'UNDO',
    'CONTROL',
    'HELP'
  ]);

  const LLM_CONFIDENCE_THRESHOLD = 0.75;

  function getMatchApi() {
    if (rootScope && rootScope.SleepwalkerMatch) return rootScope.SleepwalkerMatch;
    if (typeof require === 'function') {
      try {
        return require('./match.js');
      } catch (_e) {
        return null;
      }
    }
    return null;
  }

  function getLinkIntentApi() {
    if (rootScope && rootScope.SleepwalkerLinkIntent) return rootScope;
    if (typeof require === 'function') {
      try {
        return require('./link-intent.js');
      } catch (_e) {
        return null;
      }
    }
    return null;
  }

  const EXPLICIT_ORDINAL_MARKER_RE = /(?:^|\s)(?:number|no|num|option|choice|wala|wali|wale|1st|2nd|3rd|4th|5th|first|second|third|fourth|fifth|pehla|pahla|pehle|pahle|pahli|pehli|doosra|dusra|doosri|dusri|teesra|tisra|teesri|tisri|chautha|chauthi|paanchva|paanchwa|panchva|panchwa|पहला|पहली|पहले|दूसरा|दूसरी|दूसरे|तीसरा|तीसरी|तीसरे|चौथा|चौथी|चौथे|पांचवा|पाँचवा|पांचवां|पाँचवां|पांचवी|पाँचवी|फर्स्ट|सेकंड|थर्ड|फोर्थ|फिफ्थ|नंबर|नम्बर|ऑप्शन|विकल्प|क्रमांक|वाला|वाली|वाले)(?=$|\s)/i;

  const NON_LINK_DEVANAGARI_WORDS = new Set([
    'जा', 'जाओ', 'जाना', 'जायें', 'जाएं', 'आओ', 'आना', 'करो', 'करें', 'करना', 'कर', 'किया', 'कीजिए',
    'दो', 'लो', 'बताओ', 'बताइए', 'बताना', 'समझाओ', 'समझाइए', 'समझो', 'पढ़ो', 'पढ़ना', 'सुनाओ', 'लिखो',
    'बोलो', 'रुको', 'रोको', 'हटाओ', 'दिखाओ', 'रहो', 'चाहिए', 'सकते', 'सकता', 'सकती', 'पाऊंगा', 'पाऊँगा',
    'है', 'हैं', 'था', 'थी', 'थे', 'हो', 'हूँ', 'हूं', 'गा', 'गी', 'गे', 'रहा', 'रही', 'रहे', 'होगा', 'होगी', 'होंगे',
    'मत', 'नहीं', 'ना', 'न', 'क्या', 'कब', 'कहाँ', 'कहां', 'कैसे', 'क्यों', 'कितना', 'कितनी', 'कितने',
    'कौन', 'किसका', 'किसकी', 'किसको', 'किसने', 'कुछ', 'कोई', 'बहुत', 'क्योंकि', 'लेकिन', 'और', 'या', 'भी', 'ही', 'तो',
    'मुझे', 'मेरा', 'मेरी', 'तुम', 'हम', 'आप', 'यह', 'वह', 'ये', 'वे', 'बंद',
    // Marathi grammar/verb/postposition markers (keeps REG05 "पुढच्या पानावर जा" routing to LLM)
    'पुढच्या', 'मागील', 'पानावर', 'वर', 'खाली', 'करा', 'सांगा', 'वाचा', 'दाखवा', 'मला', 'माझ्या', 'आहे', 'नाही'
  ]);

  function isBareDevanagariLinkCandidate(text) {
    if (!text || !/^[\u0900-\u097F\s]+$/.test(text)) return false;
    const words = text.trim().split(/\s+/).filter(Boolean);
    if (words.length < 1 || words.length > 3) return false;
    return words.every((w) => !NON_LINK_DEVANAGARI_WORDS.has(w));
  }

  function escapeRegExp(str) {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  // Space/boundary-safe matchers that work for both ASCII and Devanagari scripts (unlike \b)
  function hasPhrase(haystack, phrase) {
    if (!haystack || !phrase) return false;
    const p = escapeRegExp(phrase);
    const re = new RegExp(`(?:^|[\\s,.;!?।|])${p}(?=$|[\\s,.;!?।|])`, 'i');
    return re.test(haystack);
  }

  function startsWithPhrase(haystack, phrase) {
    if (!haystack || !phrase) return false;
    const re = new RegExp(`^${escapeRegExp(phrase)}(?=$|[\\s,.;!?।|])`, 'i');
    return re.test(haystack);
  }

  // Single-word command triggers must match standalone (post-filler-strip) so words like
  // "play", "wait", "previous", "sections", "submit" do not hijack longer sentences.
  function matchesCommandPhrase(text, phrase) {
    if (!text || !phrase) return false;
    const trimmed = phrase.trim().toLowerCase();
    if (!trimmed) return false;
    if (!/\s/.test(trimmed)) {
      return text === trimmed;
    }
    return text === trimmed || hasPhrase(text, trimmed);
  }

  // Strip standalone ASCII/Devanagari tokens without \b boundaries or skipped adjacent tokens
  function stripTokens(str, tokens) {
    if (!str || !tokens || tokens.length === 0) return '';
    const sorted = tokens.slice().filter(Boolean).sort((a, b) => b.length - a.length);
    const pattern = sorted.map(escapeRegExp).join('|');
    const re = new RegExp(`(?<=^|[\\s,.;!?।|])(?:${pattern})(?=$|[\\s,.;!?।|])`, 'gi');
    return str.replace(re, ' ').replace(/\s+/g, ' ').trim();
  }

  const QUESTION_PREFIX_RE = /^(?:what|when|where|who|whom|whose|which|how|why|can\s+i|could\s+i|do\s+i|should\s+i|would\s+i|will\s+i|is\s+there|are\s+there|kya|kab|kahan|kahaan|kaise|kyun|kyon|kitni|kitna|kitne|kaun|kiske|kiska|क्या|कब|कहाँ|कहां|कैसे|क्यों|कितनी|कितना|कितने|कौन|किसके|किसका)(?=$|\s)/i;

  function startsWithQuestionPrefix(text) {
    return Boolean(text && QUESTION_PREFIX_RE.test(text));
  }

  // Distinguish explicit language-switch commands from adverbial modifiers like "hindi mein samjhao"
  function isExplicitLanguageSwitchTrigger(trig) {
    const t = (trig || '').trim().toLowerCase();
    return /\b(?:switch|speak|mode|bolo|language|bhasha)\b/i.test(t) || /बोलो/.test(t);
  }

  // Apply hinglishVariants only to leading/trailing DICTATE command words while keeping value casing intact
  function prepareDictateCaseClean(caseClean, lexicon) {
    if (!caseClean) return '';
    const tokens = caseClean.split(/\s+/);
    if (tokens.length < 2) return caseClean;
    const variants = (lexicon && lexicon.hinglishVariants) || {};
    const dictate = (lexicon && lexicon.intents && lexicon.intents.DICTATE) || {};
    const prefixes = new Set(dictate.prefixes || ['write', 'type', 'enter', 'dictate', 'input', 'fill']);
    const suffixes = new Set(dictate.suffixes || ['likho', 'daalo', 'लिखो', 'डालो']);

    const firstMapped = variants[tokens[0].toLowerCase()];
    if (firstMapped && prefixes.has(firstMapped)) {
      tokens[0] = firstMapped;
    }
    const lastIdx = tokens.length - 1;
    const lastMapped = variants[tokens[lastIdx].toLowerCase()];
    if (lastMapped && suffixes.has(lastMapped)) {
      tokens[lastIdx] = lastMapped;
    }
    return tokens.join(' ');
  }

  function detectScriptLang(text, preferredLang = 'auto') {
    if (/[\u0B80-\u0BFF]/.test(text)) return 'ta-IN'; // Tamil
    if (/[\u0C00-\u0C7F]/.test(text)) return 'te-IN'; // Telugu
    if (/[\u0980-\u09FF]/.test(text)) return 'bn-IN'; // Bengali
    if (/[\u0A80-\u0AFF]/.test(text)) return 'gu-IN'; // Gujarati
    if (/[\u0C80-\u0CFF]/.test(text)) return 'kn-IN'; // Kannada
    if (/[\u0D00-\u0D7F]/.test(text)) return 'ml-IN'; // Malayalam
    if (/[\u0A00-\u0A7F]/.test(text)) return 'pa-IN'; // Punjabi (Gurmukhi)
    if (/[\u0900-\u097F]/.test(text)) {
      return preferredLang === 'mr-IN' ? 'mr-IN' : 'hi-IN';
    }
    if (preferredLang && preferredLang !== 'auto') return preferredLang;
    return 'en-IN';
  }

  class SleepwalkerIntentEngine {
    constructor(options = {}) {
      this.lexicon = options.lexicon || null;
      this.llmCaller = typeof options.llmCaller === 'function' ? options.llmCaller : null;
      this.stats = {
        ruleHits: 0,
        llmCalls: 0,
        fallbackHits: 0
      };

      this.ready = this.lexicon
        ? Promise.resolve(this.lexicon)
        : this._loadLexiconFromExtension();
    }

    setLexicon(lexicon) {
      this.lexicon = lexicon || null;
      this.ready = Promise.resolve(this.lexicon);
    }

    async _loadLexiconFromExtension() {
      try {
        if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.getURL) {
          const url = chrome.runtime.getURL('lexicon.json');
          const res = await fetch(url);
          if (res.ok) {
            this.lexicon = await res.json();
            return this.lexicon;
          }
        }
      } catch (err) {
        console.warn('[Sleepwalker Intent] Failed to load lexicon.json:', err.message);
      }
      this.lexicon = { fillers: [], hinglishVariants: {}, devanagariDigits: {}, protectedConfirmWords: [], intents: {} };
      return this.lexicon;
    }

    /**
     * Step 1: Normalise raw transcript while preserving a case-intact clean variant for dictation values.
     */
    normalise(raw) {
      const original = typeof raw === 'string' ? raw.trim() : '';
      if (!original) {
        return {
          raw: '',
          text: '',
          caseClean: '',
          hasQuestionMark: false,
          detectedLang: 'en-IN',
          isNonRuleScript: false,
          strippedFillers: []
        };
      }

      const lex = this.lexicon || {};
      const digitsMap = lex.devanagariDigits || { '०': '0', '१': '1', '२': '2', '३': '3', '४': '4', '५': '5', '६': '6', '७': '7', '८': '8', '९': '9' };

      let caseClean = original.normalize('NFC').replace(/[०-९]/g, (d) => digitsMap[d] || d);
      const hasQuestionMark = /[?？]/.test(caseClean);
      const detectedLang = detectScriptLang(original);
      const nonRuleScripts = ['ta-IN', 'te-IN', 'bn-IN', 'gu-IN', 'kn-IN', 'ml-IN', 'pa-IN'];
      const isNonRuleScript = nonRuleScripts.includes(detectedLang);

      // Preserve internal English contractions/possessives (don't, what's, i'm) and internal dots
      // (emails/numbers), while stripping outer quotes, punctuation, and trailing/standalone dots.
      caseClean = caseClean
        .replace(/(?<=[a-zA-Z])’(?=[a-zA-Z])/g, "'")
        .replace(/[?!।|,"“”‘’]+/g, ' ')
        .replace(/(?<![a-zA-Z])'|'(?![a-zA-Z])/g, ' ')
        .replace(/(?:^|(?<=\s))\.+|\.+(?=$|\s)/g, '')
        .replace(/\s+/g, ' ')
        .trim();

      if (!caseClean) {
        return {
          raw: original,
          text: '',
          caseClean: '',
          hasQuestionMark,
          detectedLang,
          isNonRuleScript,
          strippedFillers: []
        };
      }

      let text = caseClean.toLowerCase();

      // Apply Hinglish phonetic/spelling variants (longest keys first)
      const defaultVariants = { "what's": 'what is', "i'm": 'i am' };
      const variants = { ...defaultVariants, ...(lex.hinglishVariants || {}) };
      const variantKeys = Object.keys(variants).sort((a, b) => b.length - a.length);
      for (const variant of variantKeys) {
        if (!text.includes(variant)) continue;
        const re = new RegExp(`(?<=^|\\s)${escapeRegExp(variant)}(?=$|\\s)`, 'gi');
        text = text.replace(re, variants[variant]);
      }
      text = text.replace(/\s+/g, ' ').trim();

      // Strip conversational fillers across multiple passes unless whole utterance is a protected confirmation token
      const protectedSet = new Set((lex.protectedConfirmWords || ['ok', 'okay', 'yes', 'no', 'haan', 'nahi', 'theek hai', 'ruko', 'cancel', 'हां', 'हाँ', 'नहीं']).map(s => s.toLowerCase()));
      const strippedFillers = [];

      if (!protectedSet.has(text)) {
        const fillers = (lex.fillers || []).slice().sort((a, b) => b.length - a.length);

        let textChanged = true;
        while (textChanged) {
          textChanged = false;
          if (protectedSet.has(text)) break;
          for (const filler of fillers) {
            const re = new RegExp(`(?<=^|\\s)${escapeRegExp(filler)}(?=$|\\s)`, 'gi');
            if (re.test(text)) {
              const candidate = text.replace(re, ' ').replace(/\s+/g, ' ').trim();
              if (candidate && candidate !== text) {
                if (!strippedFillers.includes(filler)) strippedFillers.push(filler);
                text = candidate;
                textChanged = true;
                if (protectedSet.has(text)) break;
              }
            }
          }
        }

        // Strip repeated leading/trailing fillers from caseClean without touching middle dictated values
        let caseChanged = true;
        while (caseChanged) {
          caseChanged = false;
          if (protectedSet.has(caseClean.toLowerCase())) break;
          for (const filler of fillers) {
            const leadRe = new RegExp(`^${escapeRegExp(filler)}\\s+`, 'i');
            if (leadRe.test(caseClean)) {
              const next = caseClean.replace(leadRe, '').trim();
              if (next && next !== caseClean) {
                caseClean = next;
                caseChanged = true;
              }
            }
            const trailRe = new RegExp(`\\s+${escapeRegExp(filler)}$`, 'i');
            if (trailRe.test(caseClean)) {
              const next = caseClean.replace(trailRe, '').trim();
              if (next && next !== caseClean && !/^(?:write|type|enter|dictate|input|fill|set)$/i.test(next)) {
                caseClean = next;
                caseChanged = true;
              }
            }
          }
        }
      }

      return {
        raw: original,
        text,
        caseClean,
        hasQuestionMark,
        detectedLang,
        isNonRuleScript,
        strippedFillers
      };
    }

    /**
     * Step 2: Deterministic rule matcher across all 13 intents (EN / HI / Hinglish).
     * Target: >= 70% resolved locally with 0 LLM calls.
     */
    matchRules(rawOrNorm, context = {}) {
      const norm = typeof rawOrNorm === 'string' ? this.normalise(rawOrNorm) : rawOrNorm;
      const text = norm.text;
      const raw = norm.raw;
      const preferredLang = context.lang || 'auto';
      const detectedLang = detectScriptLang(raw, preferredLang);
      const lexIntents = (this.lexicon && this.lexicon.intents) || {};

      const base = (intent, args = {}, confidence = 0.9, ruleId = 'rule') => ({
        intent,
        args,
        lang: detectedLang,
        confidence,
        normalized: text,
        raw,
        ruleId
      });

      if (!text) {
        return base('HELP', {}, 0.0, 'empty');
      }

      // Non-EN/HI regional Indian language scripts or explicit regional session language (unless standard English ASCII match?)
      if (norm.isNonRuleScript) {
        return base('ANSWER', { query: raw }, 0.25, 'regional_script_to_llm');
      }

      // Early link-intent follow-ups / list ("no, the other one", "the second one", "number 3", "teesra wala", "what links are there")
      const linkApi = getLinkIntentApi();
      const parsedLink = linkApi && typeof linkApi.parseLinkIntent === 'function'
        ? linkApi.parseLinkIntent(raw, context)
        : null;
      if (parsedLink) {
        if (parsedLink.action === 'LIST') {
          return base('NAVIGATE', { action: 'list_links' }, 0.94, 'link_intent_list');
        }
        if (parsedLink.action === 'CHOOSE') {
          return base('NAVIGATE', {
            action: 'choose_link',
            chooseMode: parsedLink.chooseMode || 'ordinal',
            choice: parsedLink.ordinal || 1,
            linkIntent: parsedLink
          }, 0.95, parsedLink.chooseMode === 'other' ? 'link_intent_choose_other' : 'link_intent_choose');
        }
      }

      // 1. Confirm YES / NO (prioritized when exact or when pending confirm exists)
      const yesExact = (lexIntents.CONFIRM_YES && lexIntents.CONFIRM_YES.exact) || [
        'yes', 'ok', 'okay', 'haan', 'theek hai', 'kar do',
        'हां', 'हाँ', 'ठीक है', 'कर दो', 'जी हाँ', 'हाँ कर दो', 'हां कर दो', 'ठीक बात है'
      ];
      const noExact = (lexIntents.CONFIRM_NO && lexIntents.CONFIRM_NO.exact) || [
        'no', 'nahi', 'cancel', 'mat karo', 'rehne do', "don't", 'do not',
        'नहीं', 'मत करो', 'रहने दो', 'नहीं रहने दो', 'नहीं मत करो'
      ];

      if (noExact.includes(text)) {
        return base('CONFIRM_NO', {}, 0.97, 'confirm_no_exact');
      }
      if (yesExact.includes(text)) {
        return base('CONFIRM_YES', {}, 0.97, 'confirm_yes_exact');
      }

      // Pending disambiguation / confirm ordinal choice ("1".."5", "ek", "एक", "one", "number 3", "teen number", "तीसरा", etc.)
      if (context.hasPendingNavChoice || context.hasPendingConfirm || context.hasNumberedChoices) {
        const matchApi = getMatchApi();
        const maxChoices = Number.isFinite(Number(context.maxChoices)) ? Number(context.maxChoices) : 5;
        const choice = matchApi ? matchApi.parseOrdinalChoice(text, maxChoices) : null;
        if (choice !== null) {
          return base('NAVIGATE', { action: 'choose_ordinal', choice }, 0.95, 'navigate_choose_ordinal_pending');
        }
      }
      if (context.hasPendingConfirm) {
        const noPendingStarts = ['nahi', 'nhi', 'nahin', 'mat karo', 'rehne do', 'cancel', 'abort', 'ruko', 'stop', 'band karo', "don't", 'do not', 'नहीं', 'मत करो', 'रहने दो', 'रुको', 'रोको', 'कैंसल', 'रद्द करो', 'रद्द', 'बंद करो'];
        const noPendingPhrases = ['nahi', 'mat karo', 'rehne do', 'cancel', 'नहीं', 'मत करो', 'रहने दो', 'रद्द करो'];
        if (noPendingStarts.some(p => startsWithPhrase(text, p)) || noPendingPhrases.some(p => hasPhrase(text, p))) {
          return base('CONFIRM_NO', {}, 0.95, 'confirm_no_pending');
        }

        const yesPendingStarts = ['haan', 'yes', 'ok', 'okay', 'theek', 'kar do', 'proceed', 'confirm', 'sure', 'bilkul', 'हां', 'हाँ', 'ठीक', 'कर दो', 'जी हां', 'जी हाँ', 'बिल्कुल'];
        const yesPendingPhrases = ['haan', 'theek hai', 'kar do', 'हां', 'हाँ', 'ठीक है', 'कर दो'];
        if (yesPendingStarts.some(p => startsWithPhrase(text, p)) || yesPendingPhrases.some(p => hasPhrase(text, p))) {
          return base('CONFIRM_YES', {}, 0.95, 'confirm_yes_pending');
        }
      }

      // 2. UNDO
      const undoExact = (lexIntents.UNDO && lexIntents.UNDO.exact) || ['undo', 'revert', 'clear last', 'pichla hatao', 'अनडू', 'पिछला हटाओ'];
      if (
        undoExact.includes(text) ||
        startsWithPhrase(text, 'undo') ||
        startsWithPhrase(text, 'revert') ||
        hasPhrase(text, 'pichla hatao') ||
        hasPhrase(text, 'पिछला हटाओ') ||
        hasPhrase(text, 'अनडू') ||
        hasPhrase(text, 'वापस लो')
      ) {
        return base('UNDO', {}, 0.94, 'undo');
      }

      const isQuestion = startsWithQuestionPrefix(text);

      // 2b. CAPTURE_CAMERA (camera capture checked BEFORE UPLOAD / NAVIGATE so "take a photo", "open camera" don't hit link click)
      if (!isQuestion) {
        const isCamPhrase =
          /^(?:take|capture|click|shoot|snap)\s+(?:a\s+|my\s+)?(?:photo|picture|pic|selfie|image)(?:\s+(?:for|of|in)\s+(.+))?$/i.test(text) ||
          /^(?:open|use|start)\s+(?:the\s+)?camera(?:\s+(?:for|to\s+upload)\s+(.+))?$/i.test(text) ||
          /(?:^|\s)(?:photo\s+khincho|photo\s+kheencho|camera\s+kholo|selfie\s+lo|फोटो\s+खींचो|कैमरा\s+खोलो|सेल्फी\s+लो)(?:\s|$)/i.test(text);
        if (isCamPhrase) {
          return base('UPLOAD', { mode: 'camera', target: text }, 0.94, 'upload_camera');
        }
      }

      // 3. UPLOAD (checked before CONTROL so "upload my resume" is never swallowed by CONTROL "resume";
      //    "daalo"/"डालो" only trigger UPLOAD when a document noun is also present)
      if (!isQuestion) {
        const uploadVerbs = (lexIntents.UPLOAD && lexIntents.UPLOAD.verbs) || ['upload', 'attach', 'choose file', 'select file', 'lagao', 'daalo', 'अपलोड', 'अटैच', 'लगाओ', 'डालो'];
        const docNouns = (lexIntents.UPLOAD && lexIntents.UPLOAD.docNouns) || [
          'photo', 'image', 'picture', 'signature', 'sign', 'marksheet', 'certificate',
          'income certificate', 'caste certificate', 'id', 'aadhaar', 'pan', 'document',
          'resume', 'cv', 'pdf', 'file', 'फोटो', 'मार्कशीट', 'सर्टिफिकेट', 'दस्तावेज', 'दस्तावेज़', 'फ़ाइल', 'फाइल'
        ];
        const hasDocNoun = docNouns.some(n => hasPhrase(text, n));
        const hasUploadVerb = uploadVerbs.some((v) => {
          if (v === 'daalo' || v === 'डालो') return hasPhrase(text, v) && hasDocNoun;
          return hasPhrase(text, v);
        });
        if (
          hasUploadVerb ||
          startsWithPhrase(text, 'upload') ||
          startsWithPhrase(text, 'attach') ||
          /(?:^|\s)(?:upload|अपलोड)\s+(?:karo|karna|kar\s+do|करो|करना|कीजिए)?$/i.test(text)
        ) {
          const uploadStopTokens = [
            'my', 'a', 'an', 'the', 'please', 'file', 'document', 'upload', 'attach', 'choose', 'select',
            'mera', 'meri', 'apna', 'apni', 'karo', 'karna', 'kijiye', 'kar do', 'lagao', 'daalo',
            'मेरा', 'मेरी', 'अपना', 'अपनी', 'फाइल', 'फ़ाइल', 'दस्तावेज', 'दस्तावेज़',
            'अपलोड', 'अटैच', 'लगाओ', 'डालो', 'करो', 'करना', 'कीजिए', 'कर दो'
          ];
          const target = stripTokens(text, uploadStopTokens);
          return base('UPLOAD', { target: target || 'file' }, 0.92, 'upload');
        }
      }

      // 4. CONTROL (stop, pause, resume, repeat, slower, faster, language switch)
      if (!isQuestion) {
        const ctrl = lexIntents.CONTROL || {};
        const langTable = ctrl.language || {};
        for (const [langCode, triggers] of Object.entries(langTable)) {
          for (const trig of triggers) {
            const matched = isExplicitLanguageSwitchTrigger(trig)
              ? (text === trig || hasPhrase(text, trig))
              : (text === trig);
            if (matched) {
              return base('CONTROL', { action: 'language', lang: langCode }, 0.95, `control_lang_${langCode}`);
            }
          }
        }
        if (/^(?:switch|change|set)(?:\s+language)?\s+to\s+(english|hindi|auto|tamil|telugu|bengali|marathi|gujarati|kannada|malayalam|punjabi)$/i.test(text)) {
          const langMap = {
            auto: 'auto', english: 'en-IN', hindi: 'hi-IN', tamil: 'ta-IN', telugu: 'te-IN',
            bengali: 'bn-IN', marathi: 'mr-IN', gujarati: 'gu-IN', kannada: 'kn-IN', malayalam: 'ml-IN', punjabi: 'pa-IN'
          };
          const m = text.match(/to\s+([a-z]+)$/i);
          return base('CONTROL', { action: 'language', lang: langMap[m[1].toLowerCase()] || 'en-IN' }, 0.95, 'control_lang_switch');
        }

        const controlBuckets = [
          ['slower', ctrl.slower || ['slower', 'slow down', 'speak slowly', 'read slowly', 'dheere', 'dheere padho', 'dheere bolo', 'धीरे पढ़ो', 'धीरे बोलो']],
          ['faster', ctrl.faster || ['faster', 'speed up', 'read faster', 'tez padho', 'tez bolo', 'तेज पढ़ो', 'तेज़ पढ़ो']],
          ['repeat', ctrl.repeat || ['repeat', 'read again', 'read it again', 'start over', 'dobara padho', 'phir se padho', 'फिर से पढ़ो', 'दोहराओ', 'दोबारा पढ़ो']],
          ['stop', ctrl.stop || ['stop', 'stop reading', 'shut up', 'quiet', 'band karo', 'बंद करो']],
          ['pause', ctrl.pause || ['pause', 'pause reading', 'hold on', 'wait', 'ruko', 'रोको', 'रुकिए']],
          ['resume', ctrl.resume || ['resume', 'continue reading', 'keep reading', 'play', 'jaari rakho', 'aage padho', 'जारी रखो', 'आगे पढ़ो']]
        ];
        for (const [action, phrases] of controlBuckets) {
          if (phrases.some(p => matchesCommandPhrase(text, p))) {
            return base('CONTROL', { action }, 0.94, `control_${action}`);
          }
        }
      }

      // 5. FILL_PROFILE (fill my details / use saved profile / meri details bharo)
      if (!isQuestion) {
        const profilePhrases = (lexIntents.FILL_PROFILE && lexIntents.FILL_PROFILE.phrases) || [
          'fill my details', 'fill profile', 'fill saved profile', 'autofill my details',
          'use my profile', 'meri details bharo', 'mera profile bharo', 'मेरी जानकारी भरो'
        ];
        if (
          profilePhrases.some(p => text === p || hasPhrase(text, p)) ||
          ['saved profile', 'my details', 'meri details', 'मेरी जानकारी', 'मेरा प्रोफाइल'].some(p => hasPhrase(text, p))
        ) {
          return base('FILL_PROFILE', {}, 0.93, 'fill_profile');
        }
      }

      // 6. FILL_GUIDED (prioritized BEFORE HELP so "help me fill", "help me apply",
      //    "form bharne me madad", "अप्लाई करने में मदद करो" resolve to FILL_GUIDED)
      if (!isQuestion) {
        const guidedPhrases = (lexIntents.FILL_GUIDED && lexIntents.FILL_GUIDED.phrases) || [
          'fill this form', 'fill form', 'fill out the form', 'help me fill',
          'guided fill', 'start form', 'help me apply', 'apply for this',
          'form bharo', 'form bharne me madad', 'form bharne mein madad', 'aavedan bharo',
          'फॉर्म भरो', 'आवेदन भरो', 'अप्लाई करने में मदद करो', 'फॉर्म भरने में मदद करो'
        ];
        if (
          guidedPhrases.some(p => text === p || hasPhrase(text, p)) ||
          /(?:form|aavedan|फॉर्म|आवेदन)\s+(?:bharne|भरने)\s+(?:me|mein|में)\s+(?:madad|मदद)/i.test(text) ||
          /apply\s+(?:karne|करने)\s+(?:me|mein|में)\s+(?:madad|मदद)/i.test(text)
        ) {
          const isPlan = /help me apply|apply for this|apply\s+(?:karne|करने)\s+(?:me|mein|में)\s+(?:madad|मदद)|अप्लाई करने में मदद/i.test(text);
          return base('FILL_GUIDED', { isPlan }, 0.91, isPlan ? 'fill_guided_plan' : 'fill_guided');
        }
      }

      // 6a. SEARCH (Deterministic website search bar commands prioritized BEFORE DICTATE, NAVIGATE, EXPLAIN, ANSWER)
      if (!isQuestion && !/^(?:don't|do not|mat|nahi|नहीं|मत)(?=$|\s)/i.test(text)) {
        const cleanSearchInput = norm.caseClean.replace(/[.;,!]+$/, '').trim();
        let searchQuery = '';
        let rawQuery = '';
        let siteHint = '';
        let scopeHint = '';
        let searchRuleId = '';

        const cleanExtractedSearchQuery = (q) => {
          if (!q) return '';
          let out = String(q).trim();
          out = out.replace(
            /^(?:in|into|inside|on|at|from|using)\s+(?:the\s+|this\s+|a\s+)?(?:search\s*(?:box|bar|field|input|form|area)|search|(?:web\s*)?page|website|site|portal)(?:\s+(?:for|about|on))?\s+/i,
            ''
          );
          let prev = '';
          while (out && out !== prev) {
            prev = out;
            out = out
              .replace(/\s+(?:for\s+me|please|now|right\s+now)$/i, '')
              .replace(
                /\s+(?:in|into|inside|on|at|from|using|within|to)\s+(?:the\s+|this\s+|a\s+|my\s+)?(?:[a-z0-9_.-]+\s+)?(?:search\s*(?:box|bar|field|input|form|area)|search|(?:web\s*)?page|website|site|portal)$/i,
                ''
              )
              .replace(
                /\s+(?:search\s+box|search\s+bar|search\s+field|search\s+input)\s+(?:mein|me|par|pe|में|पर|पे)$/i,
                ''
              )
              .trim();
          }
          return out
            .replace(/^(?:for|about)\s+/i, '')
            .replace(/^["'“”‘’]+|["'“”‘’]+$/g, '')
            .trim();
        };

        // Explicit search-box / search-bar target commands ("type X in the search box", "put X in the search bar", "enter X in search bar", "search X in the search box")
        const searchBoxTrailMatch = cleanSearchInput.match(
          /^(?:type|put|enter|write|fill|input|search(?:\s+for)?|look\s+up|lookup|find)\s+(.+?)\s+(?:in|into|inside|on|to)\s+(?:the\s+|this\s+|a\s+|my\s+)?(?:([a-z0-9_.-]+)\s+)?search(?:\s+(?:box|bar|field|input|form|area))?$/i
        );
        const searchBoxLeadMatch = !searchBoxTrailMatch && cleanSearchInput.match(
          /^(?:in|into|inside|on)\s+(?:the\s+|this\s+|a\s+)?(?:([a-z0-9_.-]+)\s+)?search\s*(?:box|bar|field|input|form|area)\s*(?:,\s*)?(?:type|put|enter|write|fill|input|search(?:\s+for)?|look\s+up|lookup|find)\s+(.+)$/i
        );
        const hiSearchBoxMatch = !searchBoxTrailMatch && !searchBoxLeadMatch && cleanSearchInput.match(
          /^(?:search\s*(?:box|bar|field|input)|सर्च\s*(?:बॉक्स|बार))\s+(?:mein|me|par|pe|में|पर|पे)\s+(.+?)\s+(?:likho|likh\s+do|daalo|daal\s+do|search\s+karo|लिखो|डालो|सर्च\s+करो)$/i
        );

        const searchEntireSiteMatch = !searchBoxTrailMatch && !searchBoxLeadMatch && !hiSearchBoxMatch && cleanSearchInput.match(
          /^(?:search|look\s+for|find)\s+(?:on\s+|in\s+|across\s+)?(?:the\s+|this\s+)?(entire|whole|full|complete|global)\s+(website|site|webpage|web\s+page|portal)\s+(?:for|about|on)\s+(.+)$/i
        );

        const findInfoMatch = !searchBoxTrailMatch && !searchBoxLeadMatch && !hiSearchBoxMatch && !searchEntireSiteMatch && cleanSearchInput.match(
          /^(?:find|search|look\s+for|get)\s+(information|info|articles|pages|results|details|faqs?|questions|courses?|classes|students?|faculty|professors?|teachers?|staff|notices?|announcements?|circulars?|events?|books?|products?)\s+(?:about|on|for|regarding|named|called)\s+(.+?)(?:\s+(?:on|in)\s+(?:(?:this|the)\s+(?:website|site|page|webpage|portal|search\s*(?:box|bar))|([a-z0-9_.-]+)))?$/i
        );

        const findEntityMatch = !searchBoxTrailMatch && !searchBoxLeadMatch && !hiSearchBoxMatch && !searchEntireSiteMatch && !findInfoMatch && cleanSearchInput.match(
          /^(?:find|search(?:\s+for)?|look\s+for|lookup|look\s+up)\s+(student|students|faculty|professor|professors|teacher|teachers|course|courses|faq|faqs|notice|notices|circular|circulars)\s+(?:named\s+|called\s+|for\s+|about\s+|on\s+|regarding\s+)?(.+)$/i
        );

        const findTrailingScopeMatch = !searchBoxTrailMatch && !searchBoxLeadMatch && !hiSearchBoxMatch && !searchEntireSiteMatch && !findInfoMatch && !findEntityMatch && cleanSearchInput.match(
          /^(?:find|search\s+for|search|look\s+for|look\s+up|lookup)\s+(.+?)\s+(courses?|classes|students?|faculty|faqs?|notices?|circulars?)$/i
        );

        const findOnWebsiteMatch = !searchBoxTrailMatch && !searchBoxLeadMatch && !hiSearchBoxMatch && !searchEntireSiteMatch && !findInfoMatch && !findEntityMatch && !findTrailingScopeMatch && cleanSearchInput.match(
          /^find\s+(?!and\s+(?:click|open)\b|link\b|button\b)(.+?)\s+(?:on|in|into)\s+(?:(?:this|the)\s+(?:(?:entire|whole|full|global)\s+)?(?:website|site|page|webpage|portal|search\s*(?:box|bar|field|input)))$/i
        );
        const searchForMatch = !searchBoxTrailMatch && !searchBoxLeadMatch && !hiSearchBoxMatch && !searchEntireSiteMatch && !findInfoMatch && !findEntityMatch && !findTrailingScopeMatch && !findOnWebsiteMatch && cleanSearchInput.match(
          /^(?:search|look\s+for)\s+(?:on\s+|in\s+)?(?:(?:(?:this|the)\s+(?:(?:entire|whole|full|global)\s+)?(?:website|site|page|webpage|portal))|([a-z0-9_.-]+))?\s*(?:for|about|on)\s+(.+)$/i
        );
        const searchOnSiteMatch = !searchBoxTrailMatch && !searchBoxLeadMatch && !hiSearchBoxMatch && !searchEntireSiteMatch && !findInfoMatch && !findEntityMatch && !findTrailingScopeMatch && !findOnWebsiteMatch && !searchForMatch && cleanSearchInput.match(
          /^search\s+(.+?)\s+(?:on|in)\s+(?:(?:(?:this|the)\s+(?:website|site|page|webpage|portal))|(?!the\b|this\b|a\b|search\b)([a-z0-9_.-]+))$/i
        );
        const lookUpMatch = !searchBoxTrailMatch && !searchBoxLeadMatch && !hiSearchBoxMatch && !searchEntireSiteMatch && !findInfoMatch && !findEntityMatch && !findTrailingScopeMatch && !findOnWebsiteMatch && !searchForMatch && !searchOnSiteMatch && cleanSearchInput.match(
          /^(?:look\s+up|lookup)\s+(?:(?:information|info)\s+(?:about|on|for)\s+)?(.+?)(?:\s+(?:on|in)\s+(?:(?:this|the)\s+(?:website|site|page|webpage|portal)|([a-z0-9_.-]+)))?$/i
        );
        const hiSearchMatch = !searchBoxTrailMatch && !searchBoxLeadMatch && !hiSearchBoxMatch && !searchEntireSiteMatch && !findInfoMatch && !findEntityMatch && !findTrailingScopeMatch && !findOnWebsiteMatch && !searchForMatch && !searchOnSiteMatch && !lookUpMatch && (
          cleanSearchInput.match(/^(.+?)\s+(?:ke\s+baare\s+mein\s+|ke\s+bare\s+mein\s+|के\s+बारे\s+में\s+)?(?:search\s+karo|search\s+kar\s+do|सर्च\s+करो|सर्च\s+कर\s+दो)$/i) ||
          cleanSearchInput.match(/^(?:search\s+karo|search\s+kar\s+do|सर्च\s+करो)\s+(.+)$/i)
        );
        const bareSearchMatch = !searchBoxTrailMatch && !searchBoxLeadMatch && !hiSearchBoxMatch && !searchEntireSiteMatch && !findInfoMatch && !findEntityMatch && !findTrailingScopeMatch && !findOnWebsiteMatch && !searchForMatch && !searchOnSiteMatch && !lookUpMatch && !hiSearchMatch && cleanSearchInput.match(
          /^search\s+(?!button\b|btn\b|link\b|box\b|bar\b|field\b|input\b|portal\b|form\b|icon\b|menu\b|page\b|this\s+page\b|this\s+website\b)(.+)$/i
        );

        if (searchBoxTrailMatch && searchBoxTrailMatch[1]) {
          searchQuery = cleanExtractedSearchQuery(searchBoxTrailMatch[1]);
          siteHint = (searchBoxTrailMatch[2] || '').trim();
          scopeHint = siteHint;
          searchRuleId = 'search_in_box';
        } else if (searchBoxLeadMatch && searchBoxLeadMatch[2]) {
          siteHint = (searchBoxLeadMatch[1] || '').trim();
          scopeHint = siteHint;
          searchQuery = cleanExtractedSearchQuery(searchBoxLeadMatch[2]);
          searchRuleId = 'search_box_lead';
        } else if (hiSearchBoxMatch && hiSearchBoxMatch[1]) {
          searchQuery = cleanExtractedSearchQuery(hiSearchBoxMatch[1]);
          searchRuleId = 'search_box_hi';
        } else if (searchEntireSiteMatch && searchEntireSiteMatch[3]) {
          scopeHint = 'global';
          siteHint = 'website';
          searchQuery = cleanExtractedSearchQuery(searchEntireSiteMatch[3]);
          searchRuleId = 'search_entire_website';
        } else if (findInfoMatch && findInfoMatch[2]) {
          const infoNoun = (findInfoMatch[1] || '').trim().toLowerCase();
          if (!/^(?:information|info|articles|pages|results|details)$/i.test(infoNoun)) {
            scopeHint = infoNoun;
          }
          searchQuery = cleanExtractedSearchQuery(findInfoMatch[2]);
          siteHint = (findInfoMatch[3] || '').trim();
          searchRuleId = 'navigate_search_find_info';
        } else if (findEntityMatch && findEntityMatch[2]) {
          scopeHint = (findEntityMatch[1] || '').trim().toLowerCase();
          searchQuery = cleanExtractedSearchQuery(findEntityMatch[2]);
          searchRuleId = 'search_entity_scope';
        } else if (findTrailingScopeMatch && findTrailingScopeMatch[1] && findTrailingScopeMatch[2]) {
          const candidateTerm = cleanExtractedSearchQuery(findTrailingScopeMatch[1]);
          const trailingScope = findTrailingScopeMatch[2].trim().toLowerCase();
          if (candidateTerm && !/^(?:all|the|this|my|our|available)$/i.test(candidateTerm)) {
            searchQuery = candidateTerm;
            rawQuery = `${candidateTerm} ${findTrailingScopeMatch[2].trim()}`.trim();
            scopeHint = trailingScope;
            searchRuleId = 'search_trailing_scope';
          }
        } else if (findOnWebsiteMatch && findOnWebsiteMatch[1]) {
          searchQuery = cleanExtractedSearchQuery(findOnWebsiteMatch[1]);
          if (/\b(?:entire|whole|full|global)\s+(?:website|site)\b/i.test(cleanSearchInput)) {
            scopeHint = 'global';
          }
          searchRuleId = 'search_find_on_website';
        } else if (searchForMatch && searchForMatch[2]) {
          siteHint = (searchForMatch[1] || '').trim();
          if (siteHint) scopeHint = siteHint.toLowerCase();
          else if (/\b(?:entire|whole|full|global)\s+(?:website|site|webpage|portal)\b/i.test(cleanSearchInput)) {
            scopeHint = 'global';
          }
          searchQuery = searchForMatch[2].trim();
          const trailSite = !siteHint && searchQuery.match(/^(.+?)\s+(?:on|in)\s+(?:(?:this|the)\s+(?:website|site|page|webpage|portal)|(?!the\b|this\b|a\b|search\b)([a-z0-9_.-]+))$/i);
          if (trailSite && trailSite[1]) {
            searchQuery = trailSite[1].trim();
            siteHint = (trailSite[2] || '').trim();
          }
          searchQuery = cleanExtractedSearchQuery(searchQuery.replace(/^(?:information|info|articles|details)\s+(?:about|on|for)\s+/i, ''));
          searchRuleId = siteHint ? 'navigate_search_site' : 'navigate_search';
        } else if (searchOnSiteMatch && searchOnSiteMatch[1]) {
          searchQuery = cleanExtractedSearchQuery(searchOnSiteMatch[1].replace(/^for\s+/i, ''));
          siteHint = (searchOnSiteMatch[2] || '').trim();
          if (siteHint) scopeHint = siteHint.toLowerCase();
          searchRuleId = 'navigate_search_on_site';
        } else if (lookUpMatch && lookUpMatch[1]) {
          searchQuery = cleanExtractedSearchQuery(lookUpMatch[1]);
          siteHint = (lookUpMatch[2] || '').trim();
          searchRuleId = 'navigate_lookup';
        } else if (hiSearchMatch && hiSearchMatch[1]) {
          searchQuery = cleanExtractedSearchQuery(hiSearchMatch[1]);
          searchRuleId = 'navigate_search_hi';
        } else if (bareSearchMatch && bareSearchMatch[1] && !/\b(?:button|btn|link)\s*$/i.test(bareSearchMatch[1])) {
          searchQuery = cleanExtractedSearchQuery(bareSearchMatch[1]);
          searchRuleId = 'navigate_search_direct';
        }

        if (searchQuery) {
          const args = {
            action: 'search',
            query: searchQuery,
            rawQuery: rawQuery || searchQuery,
            target: searchQuery,
            rawCommand: raw,
            searchScope: /\b(?:on|in|within)\s+(?:this|the)\s+page\b/i.test(cleanSearchInput)
              ? 'page'
              : (/\b(?:web|google|online|internet)\b/i.test(cleanSearchInput)
                  ? 'web'
                  : (/\b(?:on|in)\s+(?:this|the)\s+(?:website|site|portal)\b/i.test(cleanSearchInput) ? 'site' : 'auto'))
          };
          if (siteHint) args.siteHint = siteHint;
          if (scopeHint) args.scopeHint = scopeHint;
          return base('SEARCH', args, 0.96, searchRuleId || 'navigate_search');
        }
      }

      // 7. DICTATE (edit ops, Free Mode select/tick/switch/clear/manual/long-dictation, "write ...", "enter ...")
      const dictateOps = (lexIntents.DICTATE && lexIntents.DICTATE.ops) || [
        'new line', 'next line', 'delete that', 'erase last', 'clear field', 'clear box', 'naya line', 'mitao', 'saaf karo'
      ];
      if (dictateOps.includes(text) || text === 'clear box') {
        return base('DICTATE', { specialOp: text }, 0.93, 'dictate_edit_op');
      }

      if (/^(?:i'?ll\s+do\s+this\s+one|i\s+will\s+do\s+this\s+one|ill\s+do\s+this\s+one|i'?ll\s+fill\s+this\s+myself|let\s+me\s+enter\s+this|manual\s+takeover|mai\s+khud\s+bharunga)$/i.test(text)) {
        return base('DICTATE', { specialOp: 'manual_takeover' }, 0.94, 'dictate_manual_takeover');
      }

      if (/^(?:next\s+step|continue\s+form|save\s+and\s+continue|save\s+and\s+next|proceed\s+to\s+next\s+step)$/i.test(text)) {
        return base('DICTATE', { specialOp: 'next_step_review' }, 0.92, 'dictate_next_step');
      }

      const clearMatch = text.match(/^clear\s+(?:that|this|it)$/i) || text.match(/^clear\s+(?:the\s+|my\s+)?(.+?)(?:\s+(?:field|box|input))?$/i);
      if (clearMatch) {
        return base('DICTATE', { specialOp: 'clear', field: (clearMatch[1] || '__last__').trim() }, 0.93, 'dictate_clear_field');
      }

      // Phase 5 Personal Privacy & Reminders early guard (so "turn off learning/proactive" doesn't collide with webpage switch toggle)
      if (/\b(?:adaptive\s+learning|proactive\s+suggestions?|personal\s+context|remind\s+me|check\s+whether\s+.*\bnext\s+month|show\s+(?:my\s+)?reminders?)\b/i.test(text)) {
        return base('HELP', { subAction: 'personal_control' }, 0.91, 'personal_control_early');
      }

      // Switch toggle: "turn on notifications", "turn off dark mode", "toggle email alerts"
      const switchTurnMatch = text.match(/^(?:turn|switch)\s+(on|off)\s+(?:the\s+|my\s+)?(.+)$/i)
        || text.match(/^(?:turn|switch)\s+(?:the\s+|my\s+)?(.+?)\s+(on|off)$/i);
      if (switchTurnMatch) {
        const isFirstDir = /^(?:on|off)$/i.test(switchTurnMatch[1]);
        const stateWord = (isFirstDir ? switchTurnMatch[1] : switchTurnMatch[2]).toLowerCase();
        const fieldName = (isFirstDir ? switchTurnMatch[2] : switchTurnMatch[1]).trim();
        return base('DICTATE', { specialOp: 'switch', field: fieldName, value: stateWord }, 0.92, 'dictate_switch');
      }
      const toggleMatch = text.match(/^toggle\s+(?:the\s+|my\s+)?(.+?)(?:\s+switch)?$/i);
      if (toggleMatch && toggleMatch[1]) {
        return base('DICTATE', { specialOp: 'switch', field: toggleMatch[1].trim(), value: 'toggle' }, 0.90, 'dictate_toggle_switch');
      }

      // Checkbox / checkbox-group tick/untick: "tick blue and black", "uncheck newsletter in preferences"
      const caseCleanSelection = norm.caseClean.replace(/^(?:now|then|please)\s+/i, '').trim();
      const checkMatch = caseCleanSelection.match(/^(tick|check|select|untick|uncheck)\s+(?:the\s+)?(.+?)(?:\s+(?:in|under|from|for)\s+(?:the\s+|my\s+)?([a-z0-9\s]+?)(?:\s+(?:field|dropdown|control|group|section))?)?$/i);
      if (checkMatch && (/^(?:tick|check|untick|uncheck)$/i.test(checkMatch[1]) || checkMatch[3])) {
        const verb = checkMatch[1].toLowerCase();
        const isUncheck = verb === 'untick' || verb === 'uncheck';
        const rawOptsOrVal = checkMatch[2].trim();
        const targetField = checkMatch[3] ? checkMatch[3].replace(/\s+(?:field|dropdown|control|box)$/i, '').trim() : '';
        if (verb === 'select' && targetField) {
          return base('DICTATE', { field: targetField, value: rawOptsOrVal, subAction: 'select_option' }, 0.93, 'dictate_select_in_field');
        }
        if (verb !== 'select') {
          const multiValues = rawOptsOrVal.split(/\s*(?:,|&|\band\b|\baur\b|और)\s*/i).map((v) => v.trim()).filter(Boolean);
          return base('DICTATE', { specialOp: isUncheck ? 'uncheck' : 'check', field: targetField, value: rawOptsOrVal, multiValues }, 0.92, 'dictate_checkbox');
        }
      }

      // Choose/pick option in field: "choose India in country", "choose Germany in the country field"
      const chooseInMatch = caseCleanSelection.match(/^(?:choose|pick)\s+(?:the\s+)?(.+?)\s+(?:in|from|for|under)\s+(?:the\s+|my\s+)?([a-z0-9\s]+?)$/i);
      if (chooseInMatch && chooseInMatch[1] && chooseInMatch[2]) {
        const cleanedField = chooseInMatch[2].replace(/\s+(?:field|dropdown|control|box|selector|menu|group|section)$/i, '').trim();
        if (cleanedField) {
          return base('DICTATE', { field: cleanedField, value: chooseInMatch[1].trim(), subAction: 'select_option' }, 0.92, 'dictate_choose_in_field');
        }
      }

      // Slider / range value: "set volume slider to 75", "set budget to 50%"
      const sliderMatch = caseCleanSelection.match(/^set\s+(?:the\s+|my\s+)?(.+?(?:\bslider|\brange|\bvolume|\bbrightness|\bprice|\bbudget)?)\s+to\s+(.+)$/i);
      if (sliderMatch && /\b(?:slider|range|\d+\s*%?)\b/i.test(caseCleanSelection)) {
        return base('DICTATE', { specialOp: 'slider', field: sliderMatch[1].replace(/\s+(?:slider|range)$/i, '').trim(), value: sliderMatch[2].trim() }, 0.91, 'dictate_slider');
      }

      // Switch / select tab: "switch to security tab", "select security tab", "go to billing tab"
      const tabSwitchMatch = caseCleanSelection.match(/^(?:switch\s+to|open|go\s+to|select|choose)\s+(?:the\s+)?(.+?)\s+tab$/i);
      if (tabSwitchMatch && tabSwitchMatch[1]) {
        return base('NAVIGATE', {
          action: 'select',
          target: tabSwitchMatch[1].trim(),
          controlTypeHint: 'tab',
          subAction: 'element_select'
        }, 0.92, 'navigate_select_tab');
      }

      // General element/option selection without " in <field>":
      // "Select India.", "Choose Computer Science.", "Now select Master's degree.", "Select the second option.", "Choose the cheapest plan.", "Select the second university."
      const bareSelectMatch = caseCleanSelection.match(/^(select|choose|pick|deselect|unselect)\s+(?:the\s+)?(.+?)$/i);
      if (bareSelectMatch && bareSelectMatch[2] && !/\b(?:all\s+links|this\s+page|page)\b/i.test(bareSelectMatch[2])) {
        const sVerb = bareSelectMatch[1].toLowerCase();
        const rawTarget = bareSelectMatch[2].trim();
        const hasPendingPrompt = Boolean(context.hasPendingNavChoice || context.hasPendingConfirm || context.hasNumberedChoices);
        if (!hasPendingPrompt && !/^(?:a\s+|an\s+)?file\b/i.test(rawTarget)) {
          return base('NAVIGATE', {
            action: 'select',
            target: rawTarget,
            verb: sVerb,
            followUp: /^(?:now|then)\b/i.test(norm.caseClean),
            subAction: 'element_select'
          }, 0.92, 'navigate_element_select');
        }
      }

      // Start long dictation into textarea / contenteditable: "dictate into comments"
      const longDictMatch = norm.caseClean.match(/^(?:start\s+)?dictat(?:e|ing)\s+(?:in|into|for)\s+(?:the\s+|my\s+)?(.+?)(?:\s+field|\s+box)?$/i);
      if (longDictMatch && longDictMatch[1]) {
        return base('DICTATE', { specialOp: 'start_long_dictation', field: longDictMatch[1].trim() }, 0.91, 'dictate_long_start');
      }

      // Apply hinglishVariants only to leading/trailing command words so dictated value casing & spelling stay intact
      const dictateStr = prepareDictateCaseClean(norm.caseClean, this.lexicon);
      const hiDictateMatch = dictateStr.match(
        /^(?:(?:mera|meri|apna|apni|मेरा|मेरी|अपना|अपनी)\s+)?(phone\s+number|mobile\s+number|email\s+id|email\s+address|pin\s+code|father\s+name|mother\s+name|full\s+name|date\s+of\s+birth|पिन\s+कोड|पूरा\s+नाम|जन्म\s+तिथि|.+?)\s+(?:(?:mein|me|as|is|में)\s+)?(.+?)\s+(?:likho|likh\s+do|likhna|likh|daalo|daal\s+do|लिखो|लिख\s+दो|लिख|डालो|डाल\s+दो)$/i
      );
      if (hiDictateMatch && hiDictateMatch[2]) {
        const rawField = hiDictateMatch[1].trim();
        const rawVal = hiDictateMatch[2].trim();
        const fieldCheck = rawField.toLowerCase().normalize('NFC');
        if (
          rawField &&
          /^(?:naam|name|full\s+name|email|email\s+id|email\s+address|phone|phone\s+number|mobile|mobile\s+number|address|pata|city|pin|pincode|pin\s+code|dob|date\s+of\s+birth|age|father|father\s+name|mother|mother\s+name|नाम|पूरा\s+नाम|ईमेल|पता|फ़ोन|फोन|मोबाइल|पिनकोड|पिन\s+कोड|शहर|उम्र|जन्म\s*तिथि)$/i.test(fieldCheck)
        ) {
          return base('DICTATE', { field: rawField, value: rawVal }, 0.92, 'dictate_hi_field_val');
        }
        const combined = `${rawField} ${rawVal}`.trim();
        return base('DICTATE', { field: context.activeField || null, value: combined }, 0.87, 'dictate_hi_val');
      }
      const simpleHiDictate = dictateStr.match(
        /^(.+?)\s+(?:likho|likh\s+do|likhna|likh|daalo|daal\s+do|लिखो|लिख\s+दो|लिख|डालो|डाल\s+दो)$/i
      );
      if (simpleHiDictate && simpleHiDictate[1]) {
        return base('DICTATE', { field: context.activeField || null, value: simpleHiDictate[1].trim() }, 0.88, 'dictate_hi_simple');
      }
      const enFieldDictateMatch = dictateStr.match(/^(?:fill|set|enter|type|write)\s+(?:the\s+|my\s+)?([a-z\s]{2,24}?)\s+(?:field\s+)?(?:to|as|is|=)\s+(.+)$/i);
      if (enFieldDictateMatch) {
        return base('DICTATE', { field: enFieldDictateMatch[1].trim(), value: enFieldDictateMatch[2].trim() }, 0.92, 'dictate_en_field_val');
      }
      const enDirectFieldMatch = dictateStr.match(/^(?:fill|set|enter|type|write)\s+(?:the\s+|my\s+)?(full\s+name|name|email\s+address|email\s+id|email|phone\s+number|phone|mobile\s+number|mobile|date\s+of\s+birth|dob|address|city|state|pin\s+code|pincode|password|otp)\s+(?:field\s+)?(.+)$/i);
      if (enDirectFieldMatch) {
        return base('DICTATE', { field: enDirectFieldMatch[1].trim(), value: enDirectFieldMatch[2].trim() }, 0.92, 'dictate_en_direct_field');
      }
      const enDictateMatch = dictateStr.match(/^(?:write|type|dictate|enter)\s+(.+)$/i);
      if (enDictateMatch && enDictateMatch[1]) {
        return base('DICTATE', { field: context.activeField || null, value: enDictateMatch[1].trim() }, 0.89, 'dictate_en');
      }

      // 7a. Explicit Section Find / Jump ("find the section about eligibility", "go to the application section")
      const explicitSecFind =
        text.match(/^(?:find|locate|jump\s+to|go\s+to|take\s+me\s+to|scroll\s+to|navigate\s+to|open|show\s+(?:me)?)\s+(?:the\s+)?(?:section\s+(?:about|on|for|called|named)\s+|part\s+(?:about|on)\s+)(.+?)(?:\s+section)?$/i) ||
        text.match(/^(?:find|locate)\s+(?:the\s+)?(.+?)\s+section$/i);
      if (explicitSecFind && explicitSecFind[1]) {
        const secTarget = explicitSecFind[1].replace(/\s+section$/i, '').trim();
        if (secTarget && !/^(?:this\s+page|the\s+page|page)$/i.test(secTarget)) {
          return base('NAVIGATE', { action: 'section', target: secTarget }, 0.92, 'navigate_explicit_section');
        }
      }

      // 7b. Rich link navigation actions (FIND_THEN_CLICK, FIND, MORE_INFO) even when phrased with question words ("where is abc", "I want more info on abc")
      if (parsedLink && !/^(?:don't|do not|mat|nahi|नहीं|मत)(?=$|\s)/i.test(text)) {
        const outlineSkip = /\b(?:outline|headings|sections|commands)\b/i.test(text) || /आउटलाइन|हेडिंग|शीर्षक/.test(text);
        if (parsedLink.action === 'FIND_THEN_CLICK' && parsedLink.target) {
          return base('NAVIGATE', { action: 'find_then_click', target: parsedLink.target, linkIntent: parsedLink }, 0.92, 'link_intent_find_then_click');
        }
        if (parsedLink.action === 'FIND' && parsedLink.target && !outlineSkip) {
          return base('NAVIGATE', { action: 'find_link', target: parsedLink.target, linkIntent: parsedLink }, 0.91, 'link_intent_find');
        }
        if (parsedLink.action === 'MORE_INFO' && parsedLink.target && !/^(?:this\s+page|page)$/i.test(parsedLink.target)) {
          return base('NAVIGATE', { action: 'more_info', target: parsedLink.target, linkIntent: parsedLink }, 0.90, 'link_intent_more_info');
        }
      }

      // 8. NAVIGATE (submit critical action, outline, scroll, history/pagination, click link/button, section jump)
      if (!isQuestion && !/^(?:don't|do not|mat|nahi|नहीं|मत)(?=$|\s)/i.test(text)) {
        const nav = lexIntents.NAVIGATE || {};
        const submitList = nav.submit || ['submit', 'submit form', 'submit the form', 'submit kar do', 'form submit karo', 'सबमिट करो'];
        if (
          submitList.some(p => matchesCommandPhrase(text, p)) ||
          /^(?:click|press|tap)\s+(?:the\s+)?submit(?:\s+(?:button|btn))?$/i.test(text) ||
          /^(?:सबमिट)\s+(?:वाला\s+)?(?:बटन\s+)?(?:दबाओ|क्लिक\s+करो)$/i.test(text)
        ) {
          return base('NAVIGATE', { action: 'click', target: 'submit', isSubmit: true, risk: 'critical' }, 0.94, 'navigate_submit');
        }

        const outlineList = nav.outline || ['outline', 'show outline', 'headings', 'show headings', 'table of contents', 'sections', 'आउटलाइन', 'हेडिंग', 'शीर्षक'];
        if (
          outlineList.some(p => matchesCommandPhrase(text, p)) ||
          ['आउटलाइन दिखाओ', 'outline dikhao'].some(p => hasPhrase(text, p))
        ) {
          return base('NAVIGATE', { action: 'outline' }, 0.95, 'navigate_outline');
        }

        const scrollChecks = [
          ['top', nav.scrollTop || ['scroll to top', 'go to top', 'top of page', 'sabse upar', 'सबसे ऊपर']],
          ['bottom', nav.scrollBottom || ['scroll to bottom', 'go to bottom', 'bottom of page', 'sabse neeche', 'सबसे नीचे']],
          ['down', nav.scrollDown || ['scroll down', 'page down', 'go down', 'neeche scroll karo', 'neeche jao', 'नीचे स्क्रॉल करो', 'नीचे जाओ']],
          ['up', nav.scrollUp || ['scroll up', 'page up', 'go up', 'upar scroll karo', 'upar jao', 'ऊपर स्क्रॉल करो', 'ऊपर जाओ']]
        ];
        for (const [dir, list] of scrollChecks) {
          if (list.some(p => matchesCommandPhrase(text, p))) {
            return base('NAVIGATE', { action: 'scroll', dir }, 0.95, `navigate_scroll_${dir}`);
          }
        }

        // Check paginate (next page / previous page) before generic back/forward
        const historyChecks = [
          ['paginate', 'next', nav.nextPage || ['next page', 'agla page', 'अगला पेज']],
          ['paginate', 'prev', nav.prevPage || ['previous page', 'prev page', 'pichla page', 'पिछला पेज']],
          ['history', 'back', nav.back || ['go back', 'back', 'previous', 'wapas jao', 'peeche jao', 'वापस जाओ', 'पीछे जाओ']],
          ['history', 'forward', nav.forward || ['go forward', 'forward', 'aage jao', 'आगे जाओ']],
          ['history', 'refresh', nav.refresh || ['refresh', 'reload', 'reload page', 'refresh page', 'पेज रीलोड करो']]
        ];
        for (const [action, dir, list] of historyChecks) {
          if (list.some(p => matchesCommandPhrase(text, p))) {
            return base('NAVIGATE', { action, dir }, 0.93, `navigate_${action}_${dir}`);
          }
        }

        // Standalone explicit ordinal selection ("number 3", "teen number", "तीसरा", "पहला", "option 2", etc.)
        const matchApi = getMatchApi();
        if (matchApi && EXPLICIT_ORDINAL_MARKER_RE.test(text)) {
          const ordChoice = matchApi.parseOrdinalChoice(text, 5);
          if (ordChoice !== null) {
            return base('NAVIGATE', { action: 'choose_ordinal', choice: ordChoice }, 0.94, 'navigate_choose_ordinal');
          }
        }

        // Positional / area / reference click ("the first link in the menu", "the last button", "top right link", "click it", "a b c")
        const isExplainOrReadUtterance = /^(?:explain|summarize|summarise|read|what\s+is)\b/i.test(text) || /(?:samjhao|samjho|padho|sunao|समझाओ|पढ़ो|सुनाओ)$/i.test(text);
        if (!isExplainOrReadUtterance && parsedLink && parsedLink.action === 'CLICK' && (
          parsedLink.area || parsedLink.positionHint || parsedLink.useLastTarget ||
          (parsedLink.ordinal && !parsedLink.target) ||
          (/(?:^|\s)(?:[a-z]|[\u0905-\u0939])(?:\s+(?:[a-z]|[\u0905-\u0939]))+(?=$|\s)/i.test(text) && /^[a-z]{2,}$/.test(parsedLink.target))
        )) {
          return base('NAVIGATE', { action: 'click', target: parsedLink.target || '', linkIntent: parsedLink }, 0.90, 'link_intent_click');
        }

        // Click / Open link or button (e.g. "scholarship wala link kholo", "tomorrow show ko open karo", "टुमारो शो खोलो")
        const hiLinkClick = text.match(/^(.+?)\s+(?:(?:wala|wali|wale|वाला|वाली|वाले)\s+)?(?:link|button|btn|लिंक|बटन)?(?:\s*(?:par|pe|ko|पर|पे|को))?\s*(?:kholo|khol\s+do|dabao|daba\s+do|open\s+karo|open\s+kar\s+do|click\s+karo|click\s+kar\s+do|खोलो|खोल\s+दो|दबाओ|दबा\s+दो|ओपन\s+करो|ओपन\s+कर\s+दो|क्लिक\s+करो|क्लिक\s+कर\s+दो)$/i);
        if (hiLinkClick && hiLinkClick[1] && !['this page', 'page', 'यह पेज', 'पेज', 'इस पेज', 'इस पेज को'].includes(hiLinkClick[1].trim())) {
          const target = stripTokens(hiLinkClick[1], [
            'wala', 'wali', 'wale', 'link', 'button', 'btn', 'par', 'pe', 'ko', 'ka', 'ki', 'ke',
            'पर', 'पे', 'को', 'का', 'की', 'के', 'वाला', 'वाली', 'वाले', 'लिंक', 'बटन'
          ]);
          if (target) {
            return base('NAVIGATE', { action: 'click', target: (parsedLink && parsedLink.target) || target, linkIntent: parsedLink || null }, 0.90, 'navigate_click_hi');
          }
        }
        const enClickMatch = text.match(/^(?:open|click|press|tap|select)\s+(?:on\s+)?(?:the\s+)?(.+?)(?:\s+(?:link|button|btn))?$/i);
        if (enClickMatch && enClickMatch[1]) {
          const target = enClickMatch[1].trim();
          if (!['this page', 'page', 'menu'].includes(target)) {
            return base('NAVIGATE', { action: 'click', target: (parsedLink && parsedLink.target) || target, linkIntent: parsedLink || null }, 0.89, 'navigate_click_en');
          }
        }

        // Go to / take me to / jump to section
        const enSecNav = text.match(/^(?:take me to|go to|jump to|navigate to|scroll to|show me)\s+(?:the\s+)?(.+?)(?:\s+section)?$/i);
        if (enSecNav && enSecNav[1]) {
          const secTarget = enSecNav[1].trim();
          if (!(text.startsWith('show me ') && /^(?:how|what|why|when|where|commands)(?=$|\s)/i.test(secTarget))) {
            return base('NAVIGATE', { action: 'section', target: secTarget }, 0.89, 'navigate_section_en');
          }
        }
        const hiSecNav = text.match(/^(.+?)\s+(?:सेक्शन\s+|section\s+)?(?:par le chalo|par jao|dikhao|पर ले चलो|पर जाओ|दिखाओ)$/i);
        if (hiSecNav && hiSecNav[1] && !['यह पेज', 'पेज'].includes(hiSecNav[1].trim())) {
          return base('NAVIGATE', { action: 'section', target: hiSecNav[1].trim() }, 0.88, 'navigate_section_hi');
        }
      }

      // 9. EXPLAIN (aligned with lexicon.json phrases, level modifiers, language modifiers, action steps, section)
      const isChildLevel = /like\s+i(?:'?m|\s+am)\s+10|like\s+im\s+10|like\s+a\s+(?:child|10\s+year\s+old)|10\s+year\s+old|बच्चे\s+की\s+तरह/i.test(text);
      const isSimpleLevel = /in\s+simple\s+(?:words|language)|simple\s+words|easy\s+words|asan\s+bhasha|saral|सरल|आसान\s+भाषा/i.test(text);
      const explainLevel = isChildLevel ? 'child' : (isSimpleLevel ? 'simple' : 'standard');

      const actionStepPatterns = [
        'what do i need to do', 'what should i do', 'what are the steps',
        'mujhe kya karna hai', 'kya karna hai', 'kya karna hoga', 'isme kya karna hai',
        'मुझे क्या करना है', 'क्या करना है', 'क्या करना होगा', 'इसमें क्या करना है'
      ];
      if (actionStepPatterns.some(p => text === p || hasPhrase(text, p))) {
        return base('EXPLAIN', { mode: 'action_steps', level: explainLevel }, 0.93, 'explain_action_steps');
      }

      const explainLexPhrases = (lexIntents.EXPLAIN && Array.isArray(lexIntents.EXPLAIN.phrases)) ? lexIntents.EXPLAIN.phrases : [];
      if (explainLexPhrases.includes(text)) {
        return base('EXPLAIN', { mode: 'summary', level: explainLevel }, 0.93, 'explain_lexicon');
      }

      // Strip level & language modifiers so summary/section matching never mistakes them for section names
      const explainModifiers = [
        'in simple words', 'in simple language', 'in easy words', 'simple words',
        'asan bhasha mein', 'asan bhasha me', 'asan bhasha',
        'saral shabdon mein', 'saral shabdon me', 'saral bhasha mein',
        "like i'm 10", 'like im 10', 'like i am 10', 'like a 10 year old', 'like a child',
        'सरल शब्दों में', 'आसान भाषा में', 'बच्चे की तरह', 'सरल', 'saral',
        'hindi mein', 'hindi me', 'english mein', 'english me',
        'हिंदी में', 'हिन्दी में', 'अंग्रेजी में', 'इंग्लिश में', 'in hindi', 'in english'
      ];
      const explainBody = stripTokens(text, explainModifiers);

      if (
        (!explainBody && (isSimpleLevel || isChildLevel)) ||
        ((isSimpleLevel || isChildLevel) && /^(?:tell\s+me|batao|बताओ)$/i.test(explainBody)) ||
        /^(?:explain|summarize|summarise)(?:\s+(?:this|the|whole|entire|full|current))?(?:\s+(?:page|website|site|webpage|web\s+page|article|portal|screen|content|everything|it|this|that))?(?:\s+(?:to|for)\s+me)?$/i.test(explainBody) ||
        /^(?:what\s+is\s+(?:this|the)\s+(?:page|website|site|webpage|article|portal)(?:\s+about)?|make\s+me\s+understand(?:\s+(?:this|it|this\s+page|this\s+website))?|ye\s+(?:page|website|site)\s+kya\s+hai|is\s+(?:page|website|site)\s+ko\s+samjhao|ye\s+(?:page|website|site)\s+samjhao|(?:page|website|site)\s+samjhao|mujhe\s+samjhao|samjhao|samjho|समझाओ|यह\s+पेज\s+क्या\s+है|यह\s+पेज\s+समझाओ|पेज\s+समझाओ|इस\s+पेज\s+को\s+समझाओ|मुझे\s+समझाओ)$/i.test(explainBody) ||
        /(?:mujhe\s+samjhao|ye\s+page\s+kya\s+hai|समझाओ\s+यह\s+पेज|पेज\s+समझाओ|इस\s+पेज\s+को\s+समझाओ|यह\s+पेज\s+समझाओ)/i.test(explainBody)
      ) {
        return base('EXPLAIN', { mode: 'summary', level: explainLevel }, 0.93, 'explain_summary');
      }

      if (/^(?:explain|summarize|summarise)\s+(?:some part|a part|part|some section)(?:\s+of\s+(?:the\s+|this\s+)?(?:page|website|site))?$/i.test(explainBody)) {
        return base('EXPLAIN', { mode: 'some_part', level: explainLevel }, 0.90, 'explain_some_part');
      }

      const enExplainSec = explainBody.match(/^(?:explain|summarize|summarise)\s+(?:about\s+)?(?:the\s+|this\s+)?(?:section\s+(?:on|about|called|named)\s+|section\s+)?(.+?)(?:\s+section)?(?:\s+(?:to|for)\s+me)?$/i);
      if (enExplainSec && enExplainSec[1]) {
        const target = enExplainSec[1]
          .replace(/\s+(?:on|in)\s+(?:this|the)\s+(?:page|website|site)$/i, '')
          .replace(/\s+(?:to|for)\s+me$/i, '')
          .replace(/^(?:this|the|whole|entire|full|current)\s+/i, '')
          .trim();
        const wholePageTargets = new Set([
          'this', 'it', 'that', 'page', 'this page', 'the page', 'website', 'this website', 'the website',
          'site', 'this site', 'the site', 'webpage', 'web page', 'this webpage', 'the webpage',
          'article', 'this article', 'the article', 'portal', 'this portal', 'screen', 'everything',
          'all', 'all of it', 'content', 'to me', 'for me', 'me', 'website to me', 'page to me', 'site to me'
        ]);
        if (target && !wholePageTargets.has(target.toLowerCase())) {
          return base('EXPLAIN', { mode: 'section', target, level: explainLevel }, 0.90, 'explain_section_en');
        }
        return base('EXPLAIN', { mode: 'summary', level: explainLevel }, 0.92, 'explain_pronoun');
      }

      const hiExplainSec = explainBody.match(/^(.+?)\s+(?:सेक्शन\s+|section\s+)?(?:samjhao|ke baare mein batao|समझाओ|के बारे में बताओ)$/i);
      if (hiExplainSec && hiExplainSec[1]) {
        const target = stripTokens(hiExplainSec[1], ['mujhe', 'ye', 'yeh', 'is', 'ise', 'मुझे', 'ये', 'यह', 'इस', 'इसे']);
        if (!target || ['page', 'ye page', 'is page ko', 'website', 'ye website', 'site', 'पेज', 'यह पेज', 'इस पेज को', 'वेबसाइट', 'यह वेबसाइट', 'को'].includes(target)) {
          return base('EXPLAIN', { mode: 'summary', level: explainLevel }, 0.91, 'explain_hi_summary');
        }
        return base('EXPLAIN', { mode: 'section', target, level: explainLevel }, 0.89, 'explain_hi_section');
      }

      // 10. HELP (runs after FILL_GUIDED/DICTATE/NAVIGATE/EXPLAIN and before ANSWER)
      const helpPhrases = (lexIntents.HELP && lexIntents.HELP.exact) || [
        'help', 'commands', 'what can you do', 'how to use', 'guide me',
        'madad', 'sahayata', 'help karo', 'madad karo', 'kya kar sakte ho',
        'मदद', 'सहायता', 'क्या कर सकते हो', 'हेल्प'
      ];
      if (
        helpPhrases.some(p => matchesCommandPhrase(text, p)) ||
        /^(?:help\s+me(?:\s+out)?|i\s+need\s+help|need\s+help|can\s+you\s+help(?:\s+me)?|show\s+commands|list\s+commands|meri\s+madad\s+karo|mujhe\s+madad\s+chahiye|मदद\s+करो|मेरी\s+मदद\s+करो|सहायता\s+करो|हेल्प\s+करो|मुझे\s+मदद\s+चाहिए)$/i.test(text)
      ) {
        return base('HELP', {}, 0.94, 'help');
      }

      // 11. ANSWER (specific question about page content or "tell me about <topic>")
      const qWords = (lexIntents.ANSWER && lexIntents.ANSWER.questionWords) || ['what', 'when', 'where', 'who', 'which', 'how', 'why', 'kya', 'kitni', 'kab', 'kahan', 'kaun', 'kaise', 'isme', 'क्या', 'कितनी', 'कब', 'कहां', 'कहाँ', 'कौन', 'कैसे', 'इसमें'];
      const hasQWord = qWords.some(w => hasPhrase(text, w));
      const isTellMeAbout = /^(?:tell\s+me\s+(?:more\s+)?about|give\s+me\s+(?:information|info|details)\s+(?:about|on)|(?:what\s+does|what\s+do)\s+this\s+page\s+say)\b/i.test(text);
      if (norm.hasQuestionMark || hasQWord || isTellMeAbout) {
        return base('ANSWER', { query: raw }, (hasQWord || isTellMeAbout) ? 0.88 : 0.80, isTellMeAbout ? 'answer_tell_me_about' : 'answer_question');
      }

      // 12. READ (full page or section; strip language modifiers so "hindi mein padho" reads page)
      const readLangModifiers = [
        'hindi mein', 'hindi me', 'english mein', 'english me',
        'हिंदी में', 'हिन्दी में', 'अंग्रेजी में', 'इंग्लिश में', 'in hindi', 'in english'
      ];
      const readBody = stripTokens(text, readLangModifiers);
      if (
        /^(?:read(?:\s+(?:this|the))?\s+page|read\s+(?:this|it|that|all|everything|aloud|out|out\s+loud|content)|read\s+(?:this|it)\s+to\s+me|read\s+to\s+me|start\s+reading|read|page\s+padho|ye\s+padho|yeh\s+padho|ise\s+padho|sab\s+padho|pura\s+padho|poora\s+padho|padho|sunao|ye\s+sunao|पेज\s+पढ़ो|यह\s+पेज\s+पढ़ो|यह\s+पढ़ो|इसे\s+पढ़ो|पूरा\s+पढ़ो|सब\s+पढ़ो|पढ़ो|सुनाओ|यह\s+सुनाओ)$/i.test(readBody)
      ) {
        return base('READ', { scope: 'page' }, 0.95, 'read_page');
      }
      const enReadSec = readBody.match(/^read\s+(?:the\s+)?(?:section\s+)?(.+?)(?:\s+section)?$/i);
      if (enReadSec && enReadSec[1]) {
        const target = enReadSec[1].trim();
        if (['this', 'it', 'that', 'all', 'everything', 'aloud', 'out', 'out loud', 'page', 'this page', 'the page', 'whole page', 'full page', 'to me', 'this to me', 'it to me'].includes(target)) {
          return base('READ', { scope: 'page' }, 0.95, 'read_page_pronoun');
        }
        return base('READ', { scope: 'section', target }, 0.90, 'read_section_en');
      }
      const hiReadSec = readBody.match(/^(.+?)\s+(?:सेक्शन\s+|section\s+)?(?:padho|sunao|पढ़ो|सुनाओ)$/i);
      if (hiReadSec && hiReadSec[1]) {
        const target = hiReadSec[1].trim();
        if (['ye', 'yeh', 'ise', 'is', 'sab', 'pura', 'poora', 'page', 'ye page', 'यह', 'इसे', 'सब', 'पूरा', 'पेज', 'यह पेज', 'इस पेज को'].includes(target)) {
          return base('READ', { scope: 'page' }, 0.95, 'read_page_hi_pronoun');
        }
        return base('READ', { scope: 'section', target }, 0.90, 'read_section_hi');
      }

      // Match clickable link/button candidate in context, or bare spoken Devanagari noun-phrase target (e.g. "टुमारो शो")
      const matchApi = getMatchApi();
      if (!isQuestion && Array.isArray(context.candidates) && context.candidates.length > 0 && matchApi) {
        let bestCand = null;
        let bestScore = 0;
        for (const cand of context.candidates) {
          if (!cand) continue;
          let s = 0;
          if (typeof cand === 'object' && typeof matchApi.scoreTarget === 'function') {
            s = Math.round(matchApi.scoreTarget(cand, { target: (parsedLink && parsedLink.target) || text, action: 'CLICK' }).score * 100);
          } else {
            const label = typeof cand === 'string' ? cand : cand.label;
            if (label) s = matchApi.scoreCandidate(text, label);
          }
          if (s > bestScore) {
            bestScore = s;
            bestCand = typeof cand === 'string' ? cand : cand.label;
          }
        }
        if (bestCand && bestScore >= 52) {
          return base('NAVIGATE', { action: 'click', target: (parsedLink && parsedLink.target) || text, linkIntent: parsedLink || null }, 0.86, 'navigate_click_candidate_match');
        }
      }
      if (!isQuestion && isBareDevanagariLinkCandidate(text)) {
        return base('NAVIGATE', { action: 'click', target: (parsedLink && parsedLink.target) || text, linkIntent: parsedLink || null }, 0.84, 'navigate_bare_devanagari');
      }

      // Below confidence threshold (< 0.75) -> will trigger ONE compact LLM call in classify()
      return base('ANSWER', { query: raw }, 0.35, 'low_confidence_unmatched');
    }

    /**
     * Step 3: Full pipeline: normalise -> rules -> if confidence < 0.75 ONE compact LLM call.
     */
    async classify(raw, context = {}) {
      await this.ready;
      const cmdId = (context && context.cmdId) || `sw-${Date.now().toString(36)}`;
      const norm = this.normalise(raw);
      const ruleResult = this.matchRules(norm, context);

      const logAndReturn = (res) => {
        const out = { ...res, cmdId };
        if (out.intent === 'SEARCH' || (out.intent === 'NAVIGATE' && out.args && out.args.action === 'search') || (context && context.logSearchTrace)) {
          console.log(`[SW-SEARCH] [${cmdId}] Transcript: "${raw}"`);
          console.log(`[SW-SEARCH] [${cmdId}] Normalized: "${norm.text}"`);
          console.log(`[SW-SEARCH] [${cmdId}] Intent: ${out.intent}`);
          if (out.intent === 'SEARCH' || (out.args && out.args.action === 'search')) {
            console.log(`[SW-SEARCH] [${cmdId}] Extracted query: "${(out.args && (out.args.query || out.args.target)) || ''}"`);
          }
        }
        return out;
      };

      // Short-circuit empty / punctuation-only input without triggering an LLM call
      if (!norm.text || ruleResult.ruleId === 'empty') {
        this.stats.fallbackHits += 1;
        return logAndReturn({ ...ruleResult, source: 'fallback' });
      }

      if (ruleResult.confidence >= LLM_CONFIDENCE_THRESHOLD) {
        this.stats.ruleHits += 1;
        return logAndReturn({ ...ruleResult, source: 'rules' });
      }

      // Skip slow external LLM intent round-trip if central router already deterministically resolved the command
      if (context && context.skipLlmFallback) {
        this.stats.ruleHits += 1;
        return logAndReturn({ ...ruleResult, source: 'rules' });
      }

      // Privacy gate: NEVER transmit sensitive values, focused secret fields, or filenames to any LLM
      if (this._shouldBlockLlm(raw, norm, context)) {
        this.stats.fallbackHits += 1;
        return logAndReturn({ ...ruleResult, source: 'privacy_blocked' });
      }

      // Trigger ONE compact LLM classification call via service worker (or injected caller for tests)
      try {
        this.stats.llmCalls += 1;
        const llmResponse = await this._requestLlmClassification(raw, norm, context);
        if (llmResponse && VALID_INTENTS.has(llmResponse.intent)) {
          return logAndReturn({
            intent: llmResponse.intent,
            args: llmResponse.args && typeof llmResponse.args === 'object' ? llmResponse.args : {},
            lang: (llmResponse.lang && llmResponse.lang !== 'auto') ? llmResponse.lang : ruleResult.lang,
            confidence: typeof llmResponse.confidence === 'number' ? llmResponse.confidence : 0.78,
            normalized: norm.text,
            raw,
            source: 'llm',
            llmBackend: llmResponse.source || 'llm'
          });
        }
      } catch (err) {
        console.warn('[Sleepwalker Intent] LLM fallback error:', err.message);
      }

      this.stats.fallbackHits += 1;
      return logAndReturn({ ...ruleResult, source: 'fallback' });
    }

    _shouldBlockLlm(raw, norm, context = {}) {
      if (context && context.sensitiveActive) return true;
      const sensitiveFieldRe = /\b(?:password|passwd|pwd|otp|one[-_\s]?time|passcode|pin\b|upi|cvv|cvc|card|aadhaar|aadhar|pan|bank|ifsc|secret|ssn|captcha)\b/i;
      if (context && context.activeField && sensitiveFieldRe.test(String(context.activeField))) {
        return true;
      }
      const combined = `${String(raw || '')} ${String((norm && norm.text) || '')}`;
      if (
        /\b\d{4}[\s-]?\d{4}[\s-]?\d{4}\b/.test(combined) ||
        /\b(?:\d[\s-]?){13,19}\b/.test(combined) ||
        /\b[A-Z]{5}\d{4}[A-Z]\b/i.test(combined) ||
        sensitiveFieldRe.test(combined) ||
        /\b[^\s/\\]+\.(?:jpe?g|png|gif|webp|pdf|docx?|xlsx?|txt)\b/i.test(combined)
      ) {
        return true;
      }
      return false;
    }

    async _requestLlmClassification(raw, norm, context = {}) {
      const compactNormalized = (norm && norm.text ? norm.text : (raw || '')).trim().substring(0, 220);
      const effectiveLang = (norm && norm.isNonRuleScript && norm.detectedLang)
        ? norm.detectedLang
        : ((context.lang && context.lang !== 'auto') ? context.lang : ((norm && norm.detectedLang) || 'auto'));
      const payload = {
        normalized: compactNormalized,
        lang: effectiveLang,
        activeField: context.activeField || null,
        hasPendingConfirm: Boolean(context.hasPendingConfirm)
      };

      if (this.llmCaller) {
        return await this.llmCaller(payload);
      }

      if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.sendMessage) {
        return await new Promise((resolve) => {
          chrome.runtime.sendMessage({ type: 'SLEEPWALKER_INTENT_REQUEST', payload }, (res) => {
            if (chrome.runtime.lastError || !res || res.status !== 'ok') {
              resolve(null);
            } else {
              resolve(res);
            }
          });
        });
      }

      return null;
    }
  }

  SleepwalkerIntentEngine.VALID_INTENTS = Array.from(VALID_INTENTS);
  SleepwalkerIntentEngine.LLM_CONFIDENCE_THRESHOLD = LLM_CONFIDENCE_THRESHOLD;

  rootScope.SleepwalkerIntentEngine = SleepwalkerIntentEngine;
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = SleepwalkerIntentEngine;
  }
})(typeof window !== 'undefined' ? window : globalThis);
