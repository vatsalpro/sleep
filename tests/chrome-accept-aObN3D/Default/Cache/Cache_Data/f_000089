/**
 * Sleepwalker - link-intent.js
 * Deterministic 0-LLM sentence parser for voice link/button navigation across English, Hindi, and Hinglish.
 * Outputs { action, target, ordinal?, area?, roleHint?, positionHint?, chooseMode?, useLastTarget?, raw }.
 */
(function (root, factory) {
  const api = factory(root);
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  if (root && typeof root === 'object') {
    root.SleepwalkerLinkIntent = api.SleepwalkerLinkIntent;
    root.parseLinkIntent = api.parseLinkIntent;
  }
})(typeof globalThis !== 'undefined' ? globalThis : window, function (root) {
  'use strict';

  const DEFAULT_LEXICON = {
    fillers: [
      'please', 'can you', 'could you', 'would you', 'i want to', 'i want', 'i need',
      'link', 'links', 'button', 'buttons', 'btn',
      'the', 'a', 'an', 'on', 'par', 'pe', 'ko', 'ka', 'ki', 'ke', 'ek', 'zara',
      'kindly', 'wala', 'wali', 'wale',
      'कृपया', 'ज़रा', 'जरा', 'लिंक', 'बटन', 'पर', 'पे', 'को', 'का', 'की', 'के',
      'एक', 'वाला', 'वाली', 'वाले'
    ],
    actions: {
      LIST: [
        'what links are there', 'what links', 'read the links', 'read links',
        'list the links', 'list links', 'show all links', 'show links',
        'kaun se links hain', 'kaun kaun se links hain', 'links batao', 'links padho',
        'कौन से लिंक हैं', 'कौन कौन से लिंक हैं', 'लिंक बताओ', 'लिंक्स बताओ', 'सभी लिंक पढ़ो'
      ],
      MORE_INFO: [
        'tell me more about', 'learn more about', 'know more about',
        'more information about', 'more information on', 'more info about', 'more info on',
        'more info', 'more information', 'more about', 'details about', 'details on', 'details',
        'learn more', 'tell me more', 'know more',
        'ke baare mein aur batao', 'ke bare mein aur batao', 'ke baare mein batao',
        'ke baare mein', 'ke bare mein', 'ki jaankari chahiye', 'ki jankari chahiye',
        'jaankari chahiye', 'jankari chahiye', 'jaankari', 'jankari', 'aur batao',
        'के बारे में और बताओ', 'के बारे में बताओ', 'के बारे में', 'की जानकारी चाहिए',
        'जानकारी चाहिए', 'अधिक जानकारी', 'जानकारी', 'और बताओ', 'विवरण'
      ],
      FIND_THEN_CLICK: [
        'find and click', 'find and open', 'locate and open', 'locate and click', 'show me and click',
        'dhundo aur kholo', 'dhundho aur kholo', 'dhundo aur click karo',
        'ढूंढो और खोलो', 'ढूंढो और क्लिक करो', 'खोजो और खोलो'
      ],
      FIND: [
        'where is', 'show me', 'find', 'locate', 'highlight',
        'kahan hai', 'kaha hai', 'dhundo', 'dhundho', 'dikhao', 'batana',
        'कहाँ है', 'कहां है', 'ढूंढो', 'ढूँढो', 'दिखाओ'
      ],
      CLICK: [
        'click on', 'click', 'open', 'press', 'tap', 'go to', 'take me to',
        'navigate to', 'visit', 'select', 'launch',
        'click karo', 'open karo', 'kholo', 'kholna', 'khol do',
        'dabao', 'daba do', 'jao', 'le chalo',
        'क्लिक करो', 'क्लिक', 'ओपन करो', 'खोलो', 'खोलना', 'खोल दो',
        'दबाओ', 'दबा दो', 'जाओ', 'ले चलो'
      ],
      CANCEL: [
        'cancel', 'never mind', 'nevermind', 'abort', 'forget it', 'stop',
        'rehne do', 'chhodo', 'mat karo', 'nahi', 'nhi', 'band karo',
        'रद्द करो', 'रद्द', 'कैंसल', 'रहने दो', 'छोड़ो', 'मत करो', 'नहीं', 'बंद करो'
      ],
      OTHER_CHOICE: [
        'no the other one', 'no other one', 'the other one', 'other one',
        'doosra wala', 'dusra wala', 'koi aur', 'अगला वाला', 'दूसरा वाला', 'कोई और'
      ],
      PREV_CHOICE_REF: [
        'wo wala', 'woh wala', 'वह वाला', 'वो वाला'
      ]
    },
    areas: {
      nav: ['in the main menu', 'in main menu', 'in the menu', 'in menu', 'on the menu', 'main menu', 'navigation bar', 'nav bar', 'navbar', 'navigation', 'menu', 'nav', 'मेनू', 'मेन्यू'],
      header: ['in the header', 'in header', 'top bar', 'header', 'banner', 'हेडर'],
      footer: ['in the footer', 'in footer', 'at the bottom', 'footer', 'bottom', 'फुटर'],
      main: ['in main content', 'in the main content', 'main content', 'main section', 'article', 'मुख्य'],
      card: ['in the card', 'in this card', 'card', 'कार्ड'],
      list: ['in the list', 'in list', 'लिस्ट']
    },
    ordinals: {
      '1': 1, '1st': 1, first: 1, one: 1, ek: 1, pehla: 1, pahla: 1, 'पहला': 1, 'एक': 1,
      '2': 2, '2nd': 2, second: 2, two: 2, do: 2, doosra: 2, dusra: 2, 'दूसरा': 2, 'दो': 2,
      '3': 3, '3rd': 3, third: 3, three: 3, teen: 3, teesra: 3, tisra: 3, 'तीसरा': 3, 'तीन': 3,
      '4': 4, '4th': 4, fourth: 4, four: 4, char: 4, chaar: 4, chautha: 4, 'चौथा': 4, 'चार': 4,
      '5': 5, '5th': 5, fifth: 5, five: 5, paanch: 5, panch: 5, paanchva: 5, 'पांचवां': 5, 'पांचवा': 5, 'पांच': 5,
      '6': 6, '6th': 6, sixth: 6, six: 6, chhah: 6, 'छठा': 6,
      '7': 7, '7th': 7, seventh: 7, seven: 7, saat: 7, 'सातवां': 7,
      '8': 8, '8th': 8, eighth: 8, eight: 8, aath: 8, 'आठवां': 8,
      '9': 9, '9th': 9, ninth: 9, nine: 9, nau: 9, 'नौवां': 9,
      '10': 10, '10th': 10, tenth: 10, ten: 10, das: 10, 'दसवां': 10
    }
  };

  const DEVANAGARI_DIGITS = {
    '०': '0', '१': '1', '२': '2', '३': '3', '४': '4',
    '५': '5', '६': '6', '७': '7', '८': '8', '९': '9'
  };

  const DEVANAGARI_LETTER_NAMES = {
    'ए': 'a', 'अ': 'a', 'बी': 'b', 'सी': 'c', 'सि': 'c', 'डी': 'd', 'डि': 'd',
    'ई': 'e', 'इ': 'e', 'एफ': 'f', 'ऐफ': 'f', 'जी': 'g', 'जि': 'g', 'एच': 'h',
    'आई': 'i', 'आइ': 'i', 'जे': 'j', 'के': 'k', 'एल': 'l', 'एम': 'm', 'एन': 'n',
    'ओ': 'o', 'पी': 'p', 'पि': 'p', 'क्यू': 'q', 'आर': 'r', 'एस': 's', 'टी': 't',
    'टि': 't', 'यू': 'u', 'यु': 'u', 'वी': 'v', 'वि': 'v', 'भी': 'v',
    'डब्ल्यू': 'w', 'डब्लू': 'w', 'एक्स': 'x', 'वाई': 'y', 'जेड': 'z', 'ज़ेड': 'z'
  };

  function getMatchApi() {
    if (root && root.SleepwalkerMatch) return root.SleepwalkerMatch;
    if (typeof require === 'function') {
      try {
        return require('./match.js');
      } catch (_e) {
        return null;
      }
    }
    return null;
  }

  function escapeRe(str) {
    return String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  function boundaryTest(str, phrase) {
    if (!str || !phrase) return false;
    const re = new RegExp(`(?:^|\\s)${escapeRe(phrase)}(?=$|\\s)`, 'i');
    return re.test(str);
  }

  function stripWholePhrase(str, phrase) {
    if (!str || !phrase) return str;
    const re = new RegExp(`(?:^|\\s)${escapeRe(phrase)}(?=$|\\s)`, 'gi');
    return str.replace(re, ' ').replace(/\s+/g, ' ').trim();
  }

  function collapseSpelledLettersLocal(text) {
    const mApi = getMatchApi();
    if (mApi && typeof mApi.normalizeSpelledLetters === 'function') {
      return mApi.normalizeSpelledLetters(text);
    }
    const toks = String(text || '').split(/\s+/).filter(Boolean);
    const out = [];
    let run = '';
    let runCount = 0;
    const flush = () => {
      if (runCount >= 2) out.push(run);
      else if (runCount === 1) out.push(run);
      run = '';
      runCount = 0;
    };
    for (const tok of toks) {
      if (Object.prototype.hasOwnProperty.call(DEVANAGARI_LETTER_NAMES, tok)) {
        run += DEVANAGARI_LETTER_NAMES[tok];
        runCount += 1;
      } else if (/^[a-z]$/.test(tok)) {
        run += tok;
        runCount += 1;
      } else {
        flush();
        out.push(tok);
      }
    }
    flush();
    return out.join(' ');
  }

  class SleepwalkerLinkIntent {
    constructor(lexicon = null) {
      this.lexicon = lexicon || DEFAULT_LEXICON;
      if (!lexicon && typeof require === 'function') {
        try {
          this.lexicon = require('./link-lexicon.json');
        } catch (_e) {}
      }
    }

    async loadLexicon() {
      if (typeof chrome !== 'undefined' && chrome.runtime && typeof chrome.runtime.getURL === 'function' && typeof fetch === 'function') {
        try {
          const res = await fetch(chrome.runtime.getURL('link-lexicon.json'));
          if (res.ok) {
            this.lexicon = await res.json();
            return this.lexicon;
          }
        } catch (_e) {}
      }
      return this.lexicon;
    }

    normalise(raw) {
      let s = String(raw || '').normalize('NFC').toLowerCase();
      s = s.replace(/[०-९]/g, (d) => DEVANAGARI_DIGITS[d] || d);
      // Join intra-word hyphens ("To-Morrow" -> "tomorrow") cleanly.
      s = s.replace(/([a-z0-9\u0900-\u097F])-([a-z0-9\u0900-\u097F])/g, '$1$2');
      s = s.replace(/[.,!?।,;:'"()\[\]{}]/g, ' ').replace(/\s+/g, ' ').trim();
      return collapseSpelledLettersLocal(s);
    }

    _stripFillers(str) {
      let out = str;
      const fillers = (this.lexicon.fillers || []).slice().sort((a, b) => b.length - a.length);
      for (const f of fillers) {
        out = stripWholePhrase(out, f);
      }
      return out.replace(/\s+/g, ' ').trim();
    }

    _extractArea(text) {
      const areas = this.lexicon.areas || {};
      const allEntries = [];
      for (const [areaKey, phrases] of Object.entries(areas)) {
        for (const p of phrases) allEntries.push([areaKey, p]);
      }
      allEntries.sort((a, b) => b[1].length - a[1].length);

      for (const [areaKey, phrase] of allEntries) {
        if (boundaryTest(text, phrase)) {
          return { area: areaKey, stripped: stripWholePhrase(text, phrase) };
        }
      }
      return { area: null, stripped: text };
    }

    _extractRoleAndPosition(text, rawTargetPresent) {
      let s = text;
      let roleHint = null;
      let positionHint = null;

      if (/\b(?:top\s*right|upper\s*right|दाएं\s*ऊपर|ऊपर\s*दाएं)\b/i.test(s)) {
        positionHint = 'top_right';
        s = s.replace(/\b(?:top\s*right|upper\s*right)\b/gi, ' ').replace(/(?:दाएं\s*ऊपर|ऊपर\s*दाएं)/g, ' ');
      } else if (/\b(?:last|aakhri|akhri)\b/i.test(s) || /(?:आखिरी|अंतिम)/.test(s)) {
        positionHint = 'last';
        s = s.replace(/\b(?:the\s+)?(?:last|aakhri|akhri)\b/gi, ' ').replace(/(?:आखिरी|अंतिम)/g, ' ');
      }

      if (/\b(?:button|buttons|btn)\b/i.test(s) || /बटन/.test(s)) {
        roleHint = 'button';
      } else if (/\b(?:link|links)\b/i.test(s) || /लिंक/.test(s)) {
        roleHint = 'link';
      } else if (/\b(?:tab)\b/i.test(s)) {
        roleHint = 'tab';
      }

      if (!rawTargetPresent && /\b(?:first|1st|pehla|pahla)\b/i.test(s)) {
        positionHint = positionHint || 'first';
      }
      return { roleHint, positionHint, rest: s.replace(/\s+/g, ' ').trim() };
    }

    _matchOrdinalToken(tok) {
      const ords = this.lexicon.ordinals || DEFAULT_LEXICON.ordinals;
      if (Object.prototype.hasOwnProperty.call(ords, tok)) return ords[tok];
      return null;
    }

    _extractLeadingOrStandaloneOrdinal(text) {
      const cleaned = text
        .replace(/\b(?:the|a|an|number|no|num|option|choice|item|one|wala|wali|wale)\b/gi, ' ')
        .replace(/(?:नंबर|नम्बर|ऑप्शन|विकल्प|क्रमांक|वाला|वाली|वाले)/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
      const tokens = cleaned.split(' ').filter(Boolean);
      if (tokens.length === 1) {
        const val = this._matchOrdinalToken(tokens[0]);
        if (val !== null) return { ordinal: val, standalone: true, rest: '' };
      }

      // Positional phrase pattern: "(the) <ordinal> link/button/item" with no named target
      const posMatch = text.match(/^(?:the\s+)?(\S+)\s+(?:one|link|button|btn|item|option|वाला|वाली|लिंक|बटन)$/i);
      if (posMatch) {
        const val = this._matchOrdinalToken(posMatch[1]);
        if (val !== null) {
          return { ordinal: val, standalone: false, rest: text.slice(posMatch[0].length).trim() };
        }
      }
      return { ordinal: null, standalone: false, rest: text };
    }

    parse(rawInput, context = {}) {
      const raw = String(rawInput || '').trim();
      const norm = this.normalise(raw);
      if (!norm) {
        return { action: 'CANCEL', target: '', raw, normalized: '' };
      }

      const actions = this.lexicon.actions || DEFAULT_LEXICON.actions;
      const sortDesc = (arr) => (arr || []).slice().sort((a, b) => b.length - a.length);

      // 1. LIST ("what links are there", "read the links", "kaun se links hain")
      for (const p of sortDesc(actions.LIST)) {
        if (boundaryTest(norm, p)) {
          return { action: 'LIST', target: '', raw, normalized: norm };
        }
      }

      // 2. Follow-up OTHER_CHOICE / PREV_CHOICE_REF ("no, the other one", "wo wala") MUST beat CANCEL ("no").
      for (const p of sortDesc(actions.OTHER_CHOICE)) {
        if (boundaryTest(norm, p)) {
          return { action: 'CHOOSE', target: '', chooseMode: 'other', raw, normalized: norm };
        }
      }
      for (const p of sortDesc(actions.PREV_CHOICE_REF)) {
        if (norm === p || boundaryTest(norm, p)) {
          return { action: 'CHOOSE', target: '', ordinal: 1, chooseMode: 'it', raw, normalized: norm };
        }
      }

      // 3. CANCEL ("cancel", "rehne do", "nahi", "मत करो", "नहीं मत करो")
      let cancelRem = norm;
      let cancelHit = false;
      for (const p of sortDesc(actions.CANCEL)) {
        if (boundaryTest(cancelRem, p)) {
          cancelHit = true;
          cancelRem = stripWholePhrase(cancelRem, p);
        }
      }
      if (cancelHit && !cancelRem) {
        return { action: 'CANCEL', target: '', raw, normalized: norm };
      }

      // 4. Direct standalone ordinal follow-up ("the second one", "number 3", "teesra wala", "1", "ek", "एक")
      const hasPendingOrPos = Boolean(context.hasPendingNavChoice || context.hasNumberedChoices || context.hasPendingConfirm);
      const ordCheck = this._extractLeadingOrStandaloneOrdinal(norm);
      const explicitChoiceMarker = /\b(?:number|no|num|option|choice|one|second|third|fourth|fifth|1st|2nd|3rd|4th|5th|teesra|tisra|dusra|doosra|pehla|pahla|chautha|paanchva)\b/i.test(raw)
        || /(?:तीसरा|दूसरा|पहला|चौथा|पांचवा|पांचवां|नंबर|नम्बर|वाला|वाली)/.test(raw);
      if (ordCheck.standalone && ordCheck.ordinal !== null && (hasPendingOrPos || explicitChoiceMarker || /^\s*[1-5१-५]\s*$/.test(raw))) {
        return { action: 'CHOOSE', target: '', ordinal: ordCheck.ordinal, raw, normalized: norm };
      }

      // 5. Area & positional role hints ("the first link in the menu", "the last button", "top right link")
      const areaRes = this._extractArea(norm);
      const area = areaRes.area || undefined;
      let work = areaRes.stripped;

      // Guard against compound verb "open ... <target>": match FIND vs CLICK carefully so "Tomorrow Show" never mis-parses "show" as FIND!
      let hasFindVerb = false;
      let hasClickVerb = false;
      let hasMoreInfoVerb = false;

      // 5a. Explicit compound FIND_THEN_CLICK phrases first
      for (const p of sortDesc(actions.FIND_THEN_CLICK)) {
        if (boundaryTest(work, p)) {
          hasFindVerb = true;
          hasClickVerb = true;
          work = stripWholePhrase(work, p);
        }
      }

      // 5b. MORE_INFO detection
      for (const p of sortDesc(actions.MORE_INFO)) {
        if (boundaryTest(work, p)) {
          hasMoreInfoVerb = true;
          work = stripWholePhrase(work, p);
        }
      }

      // 5c. FIND verbs: guard bare "show" so noun phrase "tomorrow show" is NOT treated as verb "show" unless at clause start or "show me"
      for (const p of sortDesc(actions.FIND)) {
        if (p === 'show') {
          if (/^show(?:\s|$)/i.test(work) || /(?:please|can\s+you)\s+show(?:\s|$)/i.test(work)) {
            hasFindVerb = true;
            work = work.replace(/(?:please\s+|can\s+you\s+)?\bshow\b/gi, ' ').replace(/\s+/g, ' ').trim();
          }
          continue;
        }
        if (boundaryTest(work, p)) {
          hasFindVerb = true;
          work = stripWholePhrase(work, p);
        }
      }

      // 5d. CLICK verbs
      for (const p of sortDesc(actions.CLICK)) {
        if (boundaryTest(work, p)) {
          hasClickVerb = true;
          work = stripWholePhrase(work, p);
        }
      }

      // Check pronoun target ("click it", "open it", "use kholo", "find it and click it")
      let useLastTarget = false;
      const beforePronoun = work;
      work = work
        .replace(/\b(?:and\s+(?:then\s+)?|aur\s+|fir\s+)(?:on\s+)?it\b/gi, ' ')
        .replace(/^(?:it|this|that|use|isko|ise)$/i, '')
        .replace(/\b(?:and|then|aur|फिर|और)\b/gi, ' ')
        .replace(/\s+/g, ' ')
        .trim();
      if (!work && /\b(?:it|use|isko|ise)\b/i.test(beforePronoun)) {
        useLastTarget = true;
      }

      // Check positional without named target (e.g. "first link", "last button", "top right link")
      const posRole = this._extractRoleAndPosition(work, false);
      const ordInWork = this._extractLeadingOrStandaloneOrdinal(posRole.rest);

      // Strip fillers for remaining TARGET
      let cleanTarget = this._stripFillers(work);
      // If stripping fillers consumed everything ONLY when there was an ordinal/position (like "the first link"), allow empty target + ordinal/positionHint
      const strippedCheck = this._stripFillers(posRole.rest);
      const purePositional = Boolean(
        !strippedCheck ||
        ordInWork.ordinal !== null && !this._stripFillers(ordInWork.rest) ||
        (posRole.positionHint && !this._stripFillers(posRole.rest))
      );

      let action = 'CLICK';
      if (hasFindVerb && hasClickVerb) {
        action = 'FIND_THEN_CLICK';
      } else if (hasMoreInfoVerb) {
        action = 'MORE_INFO';
      } else if (hasFindVerb) {
        action = 'FIND';
      } else if (hasClickVerb) {
        action = 'CLICK';
      } else if (ordCheck.ordinal !== null && !cleanTarget) {
        action = 'CHOOSE';
      }

      const result = {
        action,
        target: purePositional && (ordInWork.ordinal !== null || posRole.positionHint || area) ? '' : cleanTarget,
        raw,
        normalized: norm
      };

      if (purePositional) {
        const ordVal = ordInWork.ordinal || (posRole.positionHint === 'first' ? 1 : null);
        if (ordVal !== null) result.ordinal = ordVal;
        if (posRole.positionHint) result.positionHint = posRole.positionHint;
        if (posRole.roleHint) result.roleHint = posRole.roleHint;
      }
      if (area) result.area = area;
      if (useLastTarget) result.useLastTarget = true;

      return result;
    }
  }

  const defaultParser = new SleepwalkerLinkIntent();
  function parseLinkIntent(rawInput, context = {}) {
    return defaultParser.parse(rawInput, context);
  }

  return { SleepwalkerLinkIntent, parseLinkIntent, DEFAULT_LEXICON };
});
