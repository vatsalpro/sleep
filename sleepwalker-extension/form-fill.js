/**
 * Sleepwalker - form-fill.js
 * Phase C2: Voice Value Parsing, Phonetic Option Matching, Custom Control Acting & Verification
 *
 * Responsibilities:
 * 1. Parse spoken numbers (EN/HI + decimals), digit-by-digit phone readback, spoken dates
 *    ("fifteen August two thousand five", Hindi months, "kal", "aaj"), emails ("at the rate",
 *    "dot", spelled letters), Title Case names, and Devanagari->Latin approximate translit.
 * 2. Phonetic-skeleton fuzzy matching for long option lists (State/Country) + close-candidate detection.
 * 3. Scroll + non-blocking visual highlight (~1s), React/Angular-safe acting for all C2 controls
 *    (native setter, hidden-input label click, switches, checkbox groups, custom combobox/listbox,
 *    contenteditable) followed by real DOM verification & honest state reporting.
 * 4. Build non-sensitive form summaries for submission/multi-step review without reading sensitive values.
 */
(function (root, factory) {
  const api = factory(root);
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  if (root && typeof root === 'object') {
    root.SleepwalkerFormFill = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : window, function (root) {
  'use strict';

  function getMatchApi() {
    if (root && root.SleepwalkerMatch) return root.SleepwalkerMatch;
    if (typeof require === 'function') {
      try { return require('./match.js'); } catch (_e) { return null; }
    }
    return null;
  }

  function getFormIndexApi() {
    if (root && root.SleepwalkerFormIndex) return root.SleepwalkerFormIndex;
    if (typeof require === 'function') {
      try { return require('./form-index.js'); } catch (_e) { return null; }
    }
    return null;
  }

  const DEVANAGARI_DIGITS = {
    '०': '0', '१': '1', '२': '2', '३': '3', '४': '4',
    '५': '5', '६': '6', '७': '7', '८': '8', '९': '9'
  };

  const ENGLISH_ONES = {
    zero: 0, oh: 0, o: 0, one: 1, two: 2, three: 3, four: 4, five: 5,
    six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
    thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17,
    eighteen: 18, nineteen: 19,
    first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7,
    eighth: 8, ninth: 9, tenth: 10, eleventh: 11, twelfth: 12, thirteenth: 13,
    fourteenth: 14, fifteenth: 15, sixteenth: 16, seventeenth: 17, eighteenth: 18,
    nineteenth: 19, twentieth: 20, twentyfirst: 21, thirtieth: 30
  };
  const ENGLISH_TENS = {
    twenty: 20, thirty: 30, forty: 40, fifty: 50,
    sixty: 60, seventy: 70, eighty: 80, ninety: 90
  };

  const HINDI_NUM_WORDS = {
    shunya: 0, ek: 1, 'एक': 1, do: 2, 'दो': 2, teen: 3, 'तीन': 3,
    char: 4, chaar: 4, 'चार': 4, paanch: 5, panch: 5, 'पांच': 5, 'पाँच': 5,
    chhah: 6, chhe: 6, che: 6, 'छह': 6, saat: 7, 'सात': 7, aath: 8, 'आठ': 8,
    nau: 9, 'नौ': 9, das: 10, 'दस': 10, gyarah: 11, 'ग्यारह': 11, barah: 12, 'बारह': 12,
    terah: 13, 'तेरह': 13, chaudah: 14, 'चौदह': 14, pandrah: 15, 'पंद्रह': 15,
    solah: 16, 'सोलह': 16, satrah: 17, 'सत्रह': 17, atharah: 18, 'अठारह': 18,
    unnees: 19, 'उन्नीस': 19, bees: 20, 'बीस': 20, ikkees: 21, 'इक्कीस': 21,
    baees: 22, 'बाईस': 22, tees: 30, 'तीस': 30, chalis: 40, 'चालीस': 40,
    pachaas: 50, 'पचास': 50, saath: 60, 'साठ': 60, sattar: 70, 'सत्तर': 70,
    assi: 80, 'अस्सी': 80, nabbe: 90, 'नब्बे': 90,
    pachees: 25, pacchees: 25, 'पच्चीस': 25
  };

  const MONTHS_MAP = {
    january: 1, jan: 1, janvari: 1, 'जनवरी': 1,
    february: 2, feb: 2, farvari: 2, 'फ़रवरी': 2, 'फरवरी': 2,
    march: 3, mar: 3, maarch: 3, 'मार्च': 3,
    april: 4, apr: 4, aprail: 4, 'अप्रैल': 4,
    may: 5, mai: 5, 'मई': 5,
    june: 6, jun: 6, joon: 6, 'जून': 6,
    july: 7, jul: 7, julai: 7, 'जुलाई': 7,
    august: 8, aug: 8, agast: 8, 'अगस्त': 8,
    september: 9, sep: 9, sept: 9, sitambar: 9, 'सितंबर': 9, 'सितम्बर': 9,
    october: 10, oct: 10, aktubar: 10, 'अक्टूबर': 10,
    november: 11, nov: 11, navambar: 11, 'नवंबर': 11, 'नवम्बर': 11,
    december: 12, dec: 12, disambar: 12, 'दिसंबर': 12, 'दिसम्बर': 12
  };

  const DEVANAGARI_VOWELS = {
    'अ': 'a', 'आ': 'aa', 'इ': 'i', 'ई': 'ee', 'उ': 'u', 'ऊ': 'oo',
    'ऋ': 'ri', 'ए': 'e', 'ऐ': 'ai', 'ओ': 'o', 'औ': 'au', 'अं': 'am', 'अः': 'ah'
  };
  const DEVANAGARI_MATRAS = {
    'ा': 'a', 'ि': 'i', 'ी': 'ee', 'ु': 'u', 'ू': 'oo',
    'ृ': 'ri', 'े': 'e', 'ै': 'ai', 'ो': 'o', 'ौ': 'au',
    'ं': 'n', 'ँ': 'n', 'ः': 'h', '्': ''
  };
  const DEVANAGARI_CONSONANTS = {
    'क': 'k', 'ख': 'kh', 'ग': 'g', 'घ': 'gh', 'ङ': 'ng',
    'च': 'ch', 'छ': 'chh', 'ज': 'j', 'झ': 'jh', 'ञ': 'ny',
    'ट': 't', 'ठ': 'th', 'ड': 'd', 'ढ': 'dh', 'ण': 'n',
    'त': 't', 'थ': 'th', 'द': 'd', 'ध': 'dh', 'न': 'n',
    'प': 'p', 'फ': 'ph', 'ब': 'b', 'भ': 'bh', 'म': 'm',
    'य': 'y', 'र': 'r', 'ल': 'l', 'व': 'v', 'श': 'sh',
    'ष': 'sh', 'स': 's', 'ह': 'h',
    'क़': 'q', 'ख़': 'kh', 'ग़': 'gh', 'ज़': 'z', 'ड़': 'r', 'ढ़': 'rh', 'फ़': 'f',
    'क्ष': 'ksh', 'त्र': 'tr', 'ज्ञ': 'gy'
  };

  function pad2(n) {
    return String(n).padStart(2, '0');
  }

  function hasDevanagari(str) {
    return /[\u0900-\u097F]/.test(String(str || ''));
  }

  function transliterateDevanagariToLatin(text) {
    const words = String(text || '').split(/(\s+)/);
    return words.map((token) => {
      if (!hasDevanagari(token)) return token;
      let out = '';
      const chars = Array.from(token);
      for (let i = 0; i < chars.length; i += 1) {
        const ch = chars[i];
        const next = chars[i + 1];
        if (DEVANAGARI_DIGITS[ch]) { out += DEVANAGARI_DIGITS[ch]; continue; }
        if (DEVANAGARI_VOWELS[ch]) { out += DEVANAGARI_VOWELS[ch]; continue; }
        const pair = ch + (next || '');
        if (next === '़' && DEVANAGARI_CONSONANTS[pair]) {
          const base = DEVANAGARI_CONSONANTS[pair];
          const after = chars[i + 2];
          i += 1;
          if (after && Object.prototype.hasOwnProperty.call(DEVANAGARI_MATRAS, after)) {
            out += base + DEVANAGARI_MATRAS[after];
            i += 1;
          } else {
            out += base + (!chars[i + 1] || !hasDevanagari(chars[i + 1]) ? '' : 'a');
          }
          continue;
        }
        if (DEVANAGARI_CONSONANTS[ch]) {
          const base = DEVANAGARI_CONSONANTS[ch];
          if (next && Object.prototype.hasOwnProperty.call(DEVANAGARI_MATRAS, next)) {
            out += base + DEVANAGARI_MATRAS[next];
            i += 1;
          } else {
            out += base + (!next || !hasDevanagari(next) ? '' : 'a');
          }
          continue;
        }
        if (Object.prototype.hasOwnProperty.call(DEVANAGARI_MATRAS, ch)) {
          out += DEVANAGARI_MATRAS[ch];
          continue;
        }
        if (ch !== '।' && ch !== '॥') out += ch;
      }
      return out;
    }).join('');
  }

  function parseSpokenNumbers(text, { strictNumericMode = false } = {}) {
    const normalized = String(text || '').replace(/[०-९]/g, (d) => DEVANAGARI_DIGITS[d] || d);
    const tokens = normalized.trim().split(/\s+/).filter(Boolean);
    if (tokens.length === 0) return '';

    const isNumTok = (raw) => {
      const w = raw.toLowerCase().replace(/[,।]+$/, '');
      if (/^\d+(?:\.\d+)?$/.test(w)) return true;
      if (Object.prototype.hasOwnProperty.call(ENGLISH_ONES, w)) return true;
      if (Object.prototype.hasOwnProperty.call(ENGLISH_TENS, w)) return true;
      if (Object.prototype.hasOwnProperty.call(HINDI_NUM_WORDS, w)) return true;
      return ['hundred', 'thousand', 'lakh', 'lac', 'sau', 'hazaar', 'hazar', 'सौ', 'हजार', 'हज़ार', 'लाख', 'point', 'dot'].includes(w);
    };

    const numHits = tokens.filter(isNumTok).length;
    if (!strictNumericMode && numHits < 2 && !(tokens.length === 1 && numHits === 1 && Object.prototype.hasOwnProperty.call(HINDI_NUM_WORDS, tokens[0].toLowerCase()))) {
      return normalized;
    }

    const singleDigitSeq = tokens.every((raw) => {
      const w = raw.toLowerCase().replace(/[,।.-]+$/, '');
      if (/^\d$/.test(w)) return true;
      if (Object.prototype.hasOwnProperty.call(ENGLISH_ONES, w) && ENGLISH_ONES[w] <= 9) return true;
      if (Object.prototype.hasOwnProperty.call(HINDI_NUM_WORDS, w) && HINDI_NUM_WORDS[w] <= 9) return true;
      return false;
    });
    if (singleDigitSeq && tokens.length >= (strictNumericMode ? 2 : 4)) {
      return tokens.map((raw) => {
        const w = raw.toLowerCase().replace(/[,।.-]+$/, '');
        if (/^\d+$/.test(w)) return w;
        if (Object.prototype.hasOwnProperty.call(ENGLISH_ONES, w)) return String(ENGLISH_ONES[w]);
        if (Object.prototype.hasOwnProperty.call(HINDI_NUM_WORDS, w)) return String(HINDI_NUM_WORDS[w]);
        return '';
      }).join('');
    }

    const out = [];
    let current = 0;
    let total = 0;
    let building = false;
    const flush = () => {
      if (building) {
        out.push(String(total + current));
        current = 0;
        total = 0;
        building = false;
      }
    };

    for (let i = 0; i < tokens.length; i += 1) {
      const raw = tokens[i];
      const w = raw.toLowerCase().replace(/[,।]+$/, '');
      if (w === 'do' && !strictNumericMode && numHits <= 1) {
        flush(); out.push(raw); continue;
      }
      if (strictNumericMode && (w === 'point' || w === 'dot') && building) {
        flush();
        out.push('.');
        continue;
      }
      if (/^\d+(?:\.\d+)?$/.test(w)) {
        if (building && (total === 2000 || (total > 0 && current === 0))) {
          current += parseFloat(w);
        } else {
          flush();
          out.push(w);
        }
        continue;
      }
      if (Object.prototype.hasOwnProperty.call(ENGLISH_ONES, w)) {
        current += ENGLISH_ONES[w];
        building = true;
      } else if (Object.prototype.hasOwnProperty.call(ENGLISH_TENS, w)) {
        current += ENGLISH_TENS[w];
        building = true;
      } else if (Object.prototype.hasOwnProperty.call(HINDI_NUM_WORDS, w)) {
        current += HINDI_NUM_WORDS[w];
        building = true;
      } else if (w === 'hundred' || w === 'sau' || w === 'सौ') {
        current = (current || 1) * 100;
        building = true;
      } else if (w === 'thousand' || w === 'hazaar' || w === 'hazar' || w === 'हजार' || w === 'हज़ार') {
        total += (current || 1) * 1000;
        current = 0;
        building = true;
      } else if (w === 'lakh' || w === 'lac' || w === 'लाख') {
        total += (current || 1) * 100000;
        current = 0;
        building = true;
      } else {
        flush();
        out.push(raw);
      }
    }
    flush();
    return out.join(' ').replace(/\s*\.\s*/g, '.');
  }

  /**
   * Parse spoken dates including spoken numbers ("fifteen August two thousand five"),
   * Hindi months ("अगस्त", "agast"), and relative terms ("aaj", "kal").
   */
  function parseSpokenDate(text, outputType = 'date', nowDate = null) {
    const rawClean = String(text || '')
      .replace(/[०-९]/g, (d) => DEVANAGARI_DIGITS[d] || d)
      .replace(/,/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (!rawClean) return null;

    const lower = rawClean.toLowerCase();
    const baseNow = nowDate instanceof Date ? new Date(nowDate.getTime()) : new Date();
    const formatDateObj = (d) => outputType === 'date'
      ? `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
      : `${pad2(d.getDate())}/${pad2(d.getMonth() + 1)}/${d.getFullYear()}`;

    if (/^(?:aaj|आज|today)$/i.test(lower)) {
      return formatDateObj(baseNow);
    }
    if (/^(?:yesterday|beeta\s+hua\s+kal|बीता\s+हुआ\s+कल)$/i.test(lower)) {
      baseNow.setDate(baseNow.getDate() - 1);
      return formatDateObj(baseNow);
    }
    if (/^(?:kal|कल|tomorrow|aane\s+wala\s+kal)$/i.test(lower)) {
      baseNow.setDate(baseNow.getDate() + 1);
      return formatDateObj(baseNow);
    }

    const withNumbers = parseSpokenNumbers(rawClean, { strictNumericMode: false })
      .replace(/(\d+)(?:st|nd|rd|th)\b/gi, '$1')
      .replace(/\s+/g, ' ')
      .trim();

    let year = null;
    let month = null;
    let day = null;

    let m = withNumbers.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/);
    if (m) {
      year = parseInt(m[1], 10); month = parseInt(m[2], 10); day = parseInt(m[3], 10);
    }

    if (!year) {
      m = withNumbers.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/);
      if (m) {
        day = parseInt(m[1], 10); month = parseInt(m[2], 10); year = parseInt(m[3], 10);
      }
    }

    if (!year) {
      const parts = withNumbers.toLowerCase().split(/\s+/);
      const monthIdx = parts.findIndex((p) => Object.prototype.hasOwnProperty.call(MONTHS_MAP, p));
      if (monthIdx !== -1) {
        month = MONTHS_MAP[parts[monthIdx]];
        const nums = [];
        for (let i = 0; i < parts.length; i += 1) {
          if (i !== monthIdx && /^\d+$/.test(parts[i])) {
            nums.push(parseInt(parts[i], 10));
          }
        }
        year = nums.find((n) => n >= 1900 && n <= 2100) || null;
        day = nums.find((n) => n >= 1 && n <= 31 && n !== year) || null;
        // Handle "two thousand five" parsed as ["2000", "5"] adjacent to year
        if (!year && nums.length >= 2) {
          const yIdx = nums.findIndex((n) => n === 2000 || n === 1900);
          if (yIdx !== -1 && nums[yIdx + 1] !== undefined && nums[yIdx + 1] < 100) {
            year = nums[yIdx] + nums[yIdx + 1];
            day = nums.find((n, idx) => idx !== yIdx && idx !== yIdx + 1 && n >= 1 && n <= 31) || null;
          }
        }
      }
    }

    if (year && month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      return outputType === 'date'
        ? `${year}-${pad2(month)}-${pad2(day)}`
        : `${pad2(day)}/${pad2(month)}/${year}`;
    }
    return null;
  }

  /**
   * Parse spoken email phrases ("a b c at the rate gmail dot com" -> "abc@gmail.com").
   */
  function parseSpokenEmail(text) {
    const matchApi = getMatchApi();
    let s = String(text || '').trim();
    if (hasDevanagari(s)) {
      s = transliterateDevanagariToLatin(s);
    }
    s = s.toLowerCase()
      .replace(/\b(?:at\s+the\s+rate(?:\s+of)?|attherate|add\s+the\s+rate|ait\s+da\s+ret|aet\s+da\s+ret|रेट)\b/gi, ' @ ')
      .replace(/\b(?:dot|डॉट)\b/gi, ' . ')
      .replace(/\bunderscore\b/gi, ' _ ')
      .replace(/\b(?:hyphen|dash)\b/gi, ' - ')
      .replace(/\bplus\b/gi, ' + ');

    if (!s.includes('@')) {
      s = s.replace(/\s+\bat\b\s+/gi, ' @ ');
    }

    const EMAIL_WORD_DIGITS = {
      zero: '0', one: '1', two: '2', three: '3', four: '4',
      five: '5', six: '6', seven: '7', eight: '8', nine: '9'
    };

    // Collapse spelled letters & standalone digit words (in local part) while keeping _, -, +, ., @ intact
    const atIdx = s.indexOf('@');
    const localRaw = atIdx >= 0 ? s.slice(0, atIdx) : s;
    const domainRaw = atIdx >= 0 ? s.slice(atIdx) : '';
    const mapSeg = (seg, convertDigitWords) => {
      return seg.split(/([._+\-])/).map((piece) => {
        if (piece === '.' || piece === '_' || piece === '-' || piece === '+') return piece;
        let trimmed = piece.trim();
        if (!trimmed) return '';
        if (convertDigitWords) {
          trimmed = trimmed.split(/\s+/).map((tok) => EMAIL_WORD_DIGITS[tok] || tok).join(' ');
        }
        if (matchApi && typeof matchApi.normalizeSpelledLetters === 'function') {
          trimmed = matchApi.normalizeSpelledLetters(trimmed) || trimmed;
        }
        return trimmed.replace(/\s+/g, '');
      }).join('');
    };
    s = mapSeg(localRaw, true) + (domainRaw ? '@' + mapSeg(domainRaw.slice(1), false) : '');

    s = s
      .replace(/\s*@\s*/g, '@')
      .replace(/\s*\.\s*/g, '.')
      .replace(/\s*_\s*/g, '_')
      .replace(/\s*-\s*/g, '-');

    if (s.includes('@')) {
      const [localPart, domainPart] = s.split('@');
      return `${localPart.replace(/\s+/g, '')}@${domainPart.replace(/\s+/g, '')}`;
    }
    return s.replace(/\s+/g, '');
  }

  function formatPhoneReadback(rawPhone) {
    const digits = String(rawPhone || '').replace(/\D/g, '');
    if (!digits) return String(rawPhone || '');
    return digits.split('').join(' ');
  }

  /**
   * Phonetic + substring fuzzy option matcher for select, radio, checkbox_group, and combobox lists.
   * Returns { status: 'matched', option, score } | { status: 'ambiguous', candidates } | { status: 'none' }.
   */
  function matchChoiceOption(options, rawQuery) {
    const q = String(rawQuery || '').trim();
    if (!q || !Array.isArray(options) || options.length === 0) return { status: 'none', candidates: [] };
    const lowerQ = q.toLowerCase().trim();

    // Ordinal or numeric option choice (e.g. "2", "option 2", "the second option", "second")
    const ordWords = { first: 1, '1st': 1, second: 2, '2nd': 2, third: 3, '3rd': 3, fourth: 4, '4th': 4, fifth: 5, '5th': 5 };
    const ordMatch = lowerQ.match(/^(?:the\s+)?(first|1st|second|2nd|third|3rd|fourth|4th|fifth|5th)(?:\s+(?:one|option|choice|item))?$/i);
    if (ordMatch) {
      const idx = ordWords[ordMatch[1].toLowerCase()] - 1;
      if (idx >= 0 && idx < options.length) {
        return { status: 'matched', option: options[idx], score: 1.0 };
      }
    }
    if (/^(?:number|option)?\s*(\d{1,2})$/i.test(lowerQ)) {
      const m = /(\d{1,2})/.exec(lowerQ);
      const idx = parseInt(m[1], 10) - 1;
      if (idx >= 0 && idx < options.length) {
        return { status: 'matched', option: options[idx], score: 1.0 };
      }
    }

    // Direct exact & punctuation-normalized exact match
    const normPunct = (s) => String(s || '').toLowerCase().replace(/[,.;:/()[\]-]+/g, ' ').replace(/\s+/g, ' ').trim();
    const normQ = normPunct(lowerQ);
    for (const opt of options) {
      const l = String(opt.label || '').toLowerCase().trim();
      const v = String(opt.value || '').toLowerCase().trim();
      if (l === lowerQ || v === lowerQ || (normQ && (normPunct(l) === normQ || normPunct(v) === normQ))) {
        return { status: 'matched', option: opt, score: 1.0 };
      }
    }

    const matchApi = getMatchApi();
    const latinQ = hasDevanagari(q) ? transliterateDevanagariToLatin(q).toLowerCase() : lowerQ;
    const qSkel = matchApi ? matchApi.phoneticSkeleton(q) : lowerQ.replace(/[aeiou\s]+/g, '');
    const qLatinSkel = matchApi ? matchApi.phoneticSkeleton(latinQ) : qSkel;

    const scored = [];
    for (const opt of options) {
      const lbl = String(opt.label || opt.value || '').trim();
      const val = String(opt.value || '').trim();
      const lLower = lbl.toLowerCase();
      let score = 0;

      if (lLower.startsWith(lowerQ) || lLower.startsWith(latinQ)) {
        score = Math.max(score, 0.92);
      } else if (lLower.includes(lowerQ) || (latinQ && lLower.includes(latinQ))) {
        score = Math.max(score, 0.85);
      } else if (lowerQ.length >= 3 && lowerQ.includes(lLower)) {
        score = Math.max(score, 0.82);
      }

      if (matchApi) {
        const textScore = matchApi.scoreFieldText(q, lbl) || (latinQ !== lowerQ ? matchApi.scoreFieldText(latinQ, lbl) : 0);
        score = Math.max(score, textScore);

        const oSkel = matchApi.phoneticSkeleton(lbl);
        const oValSkel = val ? matchApi.phoneticSkeleton(val) : '';
        if (qSkel && oSkel) {
          if (qSkel === oSkel || qLatinSkel === oSkel || (oValSkel && (qSkel === oValSkel || qLatinSkel === oValSkel))) {
            score = Math.max(score, 0.91);
          } else if (qSkel.length >= 3 && oSkel.length >= 3) {
            const d1 = matchApi.editDistance(qSkel, oSkel);
            const d2 = matchApi.editDistance(qLatinSkel, oSkel);
            const minD = Math.min(d1, d2);
            const maxLen = Math.max(qSkel.length, oSkel.length);
            const sim = Math.max(0, 1 - minD / maxLen);
            if (minD <= 1 || sim >= 0.72) {
              score = Math.max(score, Math.min(0.89, 0.65 + sim * 0.25));
            }
          }
        }
      }

      if (score >= 0.45) {
        scored.push({ option: opt, score });
      }
    }

    scored.sort((a, b) => b.score - a.score);
    if (scored.length === 0) return { status: 'none', candidates: [] };

    const top = scored[0];
    const second = scored[1];
    if (top.score >= 0.85 && (!second || top.score - second.score >= 0.12)) {
      return { status: 'matched', option: top.option, score: top.score };
    }
    if (top.score >= 0.75 && (!second || top.score - second.score >= 0.15)) {
      return { status: 'matched', option: top.option, score: top.score };
    }
    const close = scored.filter((s) => top.score - s.score <= 0.15).slice(0, 5).map((s) => s.option);
    if (close.length === 1 && top.score >= 0.65) {
      return { status: 'matched', option: close[0], score: top.score };
    }
    return { status: 'ambiguous', candidates: close.length > 0 ? close : scored.slice(0, 3).map((s) => s.option), topScore: top.score };
  }

  function highlightField(el) {
    if (!el || typeof el.scrollIntoView !== 'function') return;
    try { el.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'nearest' }); } catch (_e) {}
    if (!el.style) return;
    const prevOutline = el.style.outline;
    const prevOffset = el.style.outlineOffset;
    const prevShadow = el.style.boxShadow;
    el.style.outline = '3px solid #22D3EE';
    el.style.outlineOffset = '2px';
    el.style.boxShadow = '0 0 14px rgba(34, 211, 238, 0.55)';
    setTimeout(() => {
      if (el.style) {
        el.style.outline = prevOutline;
        el.style.outlineOffset = prevOffset;
        el.style.boxShadow = prevShadow;
      }
    }, 1050);
  }

  const _activeFormObservers = new Set();

  function disconnectAllObservers() {
    for (const obs of Array.from(_activeFormObservers)) {
      try { obs.disconnect(); } catch (_e) {}
    }
    _activeFormObservers.clear();
  }

  /**
   * Scoped MutationObserver helper: waits cleanly for dynamically rendered options/inputs
   * in React/Vue/Angular dropdowns, portals, modals, or submenus without full-DOM scanning.
   */
  function waitForDynamicDomChange(targetRoot, predicateFn, timeoutMs = 950) {
    try {
      const immediate = predicateFn();
      if (immediate) return Promise.resolve(immediate);
    } catch (_e) {}

    if (typeof MutationObserver !== 'function' || !targetRoot) {
      return new Promise((resolve) => setTimeout(() => {
        try { resolve(predicateFn()); } catch (_e) { resolve(null); }
      }, Math.min(timeoutMs, 120)));
    }

    return new Promise((resolve) => {
      let settled = false;
      let timer = null;
      const obs = new MutationObserver(() => {
        if (settled) return;
        let hit = null;
        try { hit = predicateFn(); } catch (_e) {}
        if (hit) {
          settled = true;
          clearTimeout(timer);
          try { obs.disconnect(); } catch (_e) {}
          _activeFormObservers.delete(obs);
          resolve(hit);
        }
      });
      _activeFormObservers.add(obs);
      try {
        obs.observe(targetRoot, { childList: true, subtree: true, attributes: true, attributeFilter: ['hidden', 'aria-expanded', 'aria-selected', 'aria-disabled', 'class', 'style'] });
      } catch (_e) {}
      timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        try { obs.disconnect(); } catch (_e) {}
        _activeFormObservers.delete(obs);
        let finalHit = null;
        try { finalHit = predicateFn(); } catch (_e) {}
        resolve(finalHit);
      }, timeoutMs);
    });
  }

  /**
   * React/Vue/Angular-safe native value setter (uses property descriptor + resets React _valueTracker).
   */
  function setNativeValue(el, valueStr) {
    if (!el) return;
    const tag = String(el.tagName || '').toUpperCase();
    const proto = tag === 'TEXTAREA'
      ? (typeof HTMLTextAreaElement !== 'undefined' ? HTMLTextAreaElement.prototype : null)
      : (tag === 'SELECT'
          ? (typeof HTMLSelectElement !== 'undefined' ? HTMLSelectElement.prototype : null)
          : (typeof HTMLInputElement !== 'undefined' ? HTMLInputElement.prototype : null));
    const desc = proto && Object.getOwnPropertyDescriptor(proto, 'value');
    const prevVal = el.value;
    if (desc && typeof desc.set === 'function') {
      desc.set.call(el, valueStr);
    } else {
      el.value = valueStr;
    }
    if (el._valueTracker && typeof el._valueTracker.setValue === 'function') {
      try { el._valueTracker.setValue(prevVal); } catch (_e) {}
    }
  }

  function dispatchControlEvents(el, { includeClick = false, includeBlur = true, includeKeyboard = false, inputData = null } = {}) {
    if (!el || typeof el.dispatchEvent !== 'function') return;
    const Ev = typeof Event === 'function'
      ? Event
      : function MockEv(t, opts) { this.type = t; this.bubbles = Boolean(opts && opts.bubbles); this.composed = Boolean(opts && opts.composed); };
    const InpEv = typeof InputEvent === 'function' ? InputEvent : Ev;
    const evOpts = { bubbles: true, composed: true };
    if (includeClick) {
      el.dispatchEvent(new Ev('mousedown', evOpts));
      el.dispatchEvent(new Ev('mouseup', evOpts));
      el.dispatchEvent(new Ev('click', evOpts));
    }
    if (includeKeyboard) {
      el.dispatchEvent(new Ev('keydown', evOpts));
    }
    try {
      el.dispatchEvent(new InpEv('beforeinput', { bubbles: true, composed: true, inputType: 'insertText', data: inputData }));
    } catch (_e) {}
    try {
      el.dispatchEvent(new InpEv('input', { bubbles: true, composed: true, inputType: 'insertText', data: inputData }));
    } catch (_e) {
      el.dispatchEvent(new Ev('input', evOpts));
    }
    el.dispatchEvent(new Ev('change', evOpts));
    if (includeKeyboard) {
      el.dispatchEvent(new Ev('keyup', evOpts));
    }
    if (includeBlur) el.dispatchEvent(new Ev('blur', evOpts));
  }

  function setSelectMultiple(el, requestedValues, { replace = false } = {}) {
    if (!el || !el.options) return { ok: false, error: 'Multi-select control unavailable.' };
    const targets = Array.isArray(requestedValues)
      ? requestedValues
      : String(requestedValues || '').split(/\s*(?:,|&|\band\b|\baur\b|और)\s*/i).map((x) => x.trim()).filter(Boolean);
    if (targets.length === 0) return { ok: false, error: 'No options specified.' };

    const allOpts = Array.from(el.options)
      .filter((o) => String(o.value || '').trim() !== '')
      .map((o) => ({
        element: o,
        value: o.value,
        label: (o.textContent || o.label || o.value || '').replace(/\s+/g, ' ').trim(),
        disabled: Boolean(o.disabled)
      }));

    const picked = [];
    for (const q of targets) {
      const m = matchChoiceOption(allOpts, q);
      if (m.status === 'ambiguous') {
        return { ok: false, status: 'ambiguous', candidates: m.candidates, error: `Multiple options match "${q}".` };
      }
      if (m.status !== 'matched' || !m.option) {
        return { ok: false, error: `Could not find option "${q}" in multi-select.` };
      }
      if (m.option.disabled) {
        return { ok: false, status: 'disabled', error: `Option "${m.option.label}" is currently disabled.` };
      }
      picked.push(m.option);
    }

    const pickedVals = new Set(picked.map((p) => String(p.value)));
    for (const opt of Array.from(el.options)) {
      const val = String(opt.value || '');
      if (pickedVals.has(val)) {
        opt.selected = true;
      } else if (replace) {
        opt.selected = false;
      }
    }
    dispatchControlEvents(el);
    const verifiedSel = Array.from(el.options).filter((o) => o.selected).map((o) => String(o.value));
    const allApplied = picked.every((p) => verifiedSel.includes(String(p.value)));
    if (!allApplied) {
      return { ok: false, verified: false, error: 'Page did not retain selected multi-select options.' };
    }
    return {
      ok: true,
      verified: true,
      appliedValue: Array.from(el.options).filter((o) => o.selected).map((o) => (o.textContent || o.value || '').trim()).join(', '),
      selectedLabels: Array.from(el.options).filter((o) => o.selected).map((o) => (o.textContent || o.value || '').trim())
    };
  }

  function setRangeValue(el, rawVal) {
    if (!el) return { ok: false, error: 'Range slider element missing.' };
    const isInput = String(el.tagName || '').toUpperCase() === 'INPUT';
    const readAttr = (attr) => (el.getAttribute && el.getAttribute(attr)) || '';
    const minRaw = isInput ? ((el.min !== undefined && el.min !== '') ? el.min : readAttr('min')) : readAttr('aria-valuemin');
    const maxRaw = isInput ? ((el.max !== undefined && el.max !== '') ? el.max : readAttr('max')) : readAttr('aria-valuemax');
    const stepRaw = isInput ? ((el.step !== undefined && el.step !== '') ? el.step : readAttr('step')) : readAttr('data-step');
    const min = minRaw !== '' && Number.isFinite(Number(minRaw)) ? Number(minRaw) : 0;
    const max = maxRaw !== '' && Number.isFinite(Number(maxRaw)) ? Number(maxRaw) : 100;
    const step = Math.max(0.001, (stepRaw !== '' && Number.isFinite(Number(stepRaw))) ? Number(stepRaw) : 1);
    const rawStr = String(rawVal || '').trim().toLowerCase();
    let targetNum = Number.NaN;
    if (/^(?:max|maximum|highest|full)$/.test(rawStr)) targetNum = max;
    else if (/^(?:min|minimum|lowest|zero)$/.test(rawStr)) targetNum = min;
    else if (/^(?:half|middle|mid|50%)$/.test(rawStr)) targetNum = min + (max - min) * 0.5;
    else if (/^(\d+(?:\.\d+)?)\s*%$/.test(rawStr)) {
      const pct = parseFloat(rawStr) / 100;
      targetNum = min + (max - min) * pct;
    } else {
      const numMatch = rawStr.match(/-?\d+(?:\.\d+)?/);
      if (numMatch) targetNum = parseFloat(numMatch[0]);
    }
    if (!Number.isFinite(targetNum)) {
      return { ok: false, error: `Could not understand numeric slider value "${rawVal}".` };
    }
    const clamped = Math.min(max, Math.max(min, targetNum));
    const stepped = Math.round((clamped - min) / step) * step + min;
    const finalNum = Number(stepped.toFixed(4));
    if (isInput) {
      setNativeValue(el, String(finalNum));
      dispatchControlEvents(el);
      const actual = Number(el.value);
      const verified = Math.abs(actual - finalNum) <= step;
      return { ok: verified, verified, appliedValue: String(actual), error: verified ? '' : `Slider remained at ${actual}` };
    }
    if (typeof el.setAttribute === 'function') {
      el.setAttribute('aria-valuenow', String(finalNum));
      dispatchControlEvents(el);
    }
    const actualAria = Number(el.getAttribute && el.getAttribute('aria-valuenow'));
    return { ok: actualAria === finalNum, verified: actualAria === finalNum, appliedValue: String(actualAria) };
  }

  function collectFieldValidationErrors(fieldDescriptor, doc = (typeof document !== 'undefined' ? document : null)) {
    const el = fieldDescriptor && fieldDescriptor.element;
    if (!el || fieldDescriptor.sensitive) return [];
    const errors = [];

    if (typeof el.checkValidity === 'function' && !el.checkValidity()) {
      if (el.validationMessage) errors.push(el.validationMessage);
    }

    const describedBy = typeof el.getAttribute === 'function' ? el.getAttribute('aria-describedby') : '';
    if (describedBy && doc) {
      for (const id of describedBy.trim().split(/\s+/)) {
        const errNode = typeof doc.getElementById === 'function' ? doc.getElementById(id) : null;
        if (errNode) {
          const msg = (errNode.innerText || errNode.textContent || '').trim();
          if (msg) errors.push(msg);
        }
      }
    }

    const ariaInvalid = typeof el.getAttribute === 'function' && el.getAttribute('aria-invalid') === 'true';
    const parent = el.parentElement;
    if (parent && typeof parent.querySelector === 'function') {
      const near = parent.querySelector('.error, .invalid-feedback, .field-error, [role="alert"]');
      if (near) {
        const msg = (near.innerText || near.textContent || '').trim();
        if (msg && (ariaInvalid || /\b(?:error|invalid|required|must|enter|valid)\b/i.test(msg))) {
          errors.push(msg);
        }
      }
    }
    return Array.from(new Set(errors));
  }

  /**
   * Click a custom/hidden checkbox or switch cleanly (via visible label when real input is hidden) and verify state.
   */
  function toggleBinaryElement(el, clickTarget, desiredChecked) {
    const isNativeInput = String(el.tagName || '').toUpperCase() === 'INPUT';
    const currentChecked = isNativeInput
      ? Boolean(el.checked)
      : (typeof el.getAttribute === 'function' && el.getAttribute('aria-checked') === 'true');

    if (currentChecked !== desiredChecked) {
      if (clickTarget && clickTarget !== el && typeof clickTarget.click === 'function') {
        clickTarget.click();
      } else if (typeof el.click === 'function') {
        el.click();
      }
      // Re-check after click; if framework didn't flip native checkbox or mock lacks click state flip, set explicitly + events
      const afterClick = isNativeInput
        ? Boolean(el.checked)
        : (typeof el.getAttribute === 'function' && el.getAttribute('aria-checked') === 'true');
      if (afterClick !== desiredChecked) {
        if (isNativeInput) {
          el.checked = desiredChecked;
        } else if (typeof el.setAttribute === 'function') {
          el.setAttribute('aria-checked', desiredChecked ? 'true' : 'false');
        }
      }
    }
    dispatchControlEvents(el, { includeClick: false, includeBlur: true });

    const finalChecked = isNativeInput
      ? Boolean(el.checked)
      : (typeof el.getAttribute === 'function' && el.getAttribute('aria-checked') === 'true');
    return finalChecked;
  }

  /**
   * Act on custom [role=combobox] or [role=listbox] asynchronously:
   * opens trigger -> filters if filter input exists -> scans visible [role=option] -> clicks match -> verifies!
   */
  async function applyComboboxValue(fieldDescriptor, rawInputValue, opts = {}) {
    const el = fieldDescriptor.element;
    const trigger = fieldDescriptor.triggerElement || el;
    let inputEl = fieldDescriptor.inputElement || null;
    const doc = (el && el.ownerDocument) || (typeof document !== 'undefined' ? document : null);
    const indexApi = getFormIndexApi();

    if (fieldDescriptor.disabled || (el && (el.disabled || (el.getAttribute && el.getAttribute('aria-disabled') === 'true')))) {
      return { ok: false, status: 'disabled', verified: false, error: `"${fieldDescriptor.label}" is currently disabled.` };
    }

    highlightField(trigger);
    if (typeof trigger.focus === 'function') trigger.focus();

    if (fieldDescriptor.comboboxKind === 'datalist' && inputEl) {
      const m = matchChoiceOption(fieldDescriptor.options || [], rawInputValue);
      const val = m.status === 'matched' ? (m.option.label || m.option.value) : String(rawInputValue || '');
      setNativeValue(inputEl, val);
      dispatchControlEvents(inputEl);
      const actual = String(inputEl.value || '').trim();
      return {
        ok: actual.toLowerCase() === val.toLowerCase(),
        appliedValue: actual || val,
        verified: actual.toLowerCase() === val.toLowerCase(),
        validationErrors: collectFieldValidationErrors(fieldDescriptor, doc)
      };
    }

    if (typeof trigger.click === 'function') {
      trigger.click();
    } else if (typeof trigger.dispatchEvent === 'function') {
      dispatchControlEvents(trigger, { includeClick: true, includeBlur: false });
    }

    const gatherVisibleOptions = () => {
      let optsList = indexApi && typeof indexApi.resolveListboxOptions === 'function'
        ? indexApi.resolveListboxOptions(el, doc, { includeDisabled: true })
        : (fieldDescriptor.options || []);
      if (optsList.length === 0 && doc && typeof doc.querySelectorAll === 'function') {
        const popSel = '[role="listbox"] [role="option"], [role="menu"] [role="menuitem"], .dropdown-menu .dropdown-item, .dropdown-options .option-item, .select-options .select-option, .autocomplete-suggestions .suggestion-item, ul.suggestions > li, [role="option"]';
        const visiblePopups = Array.from(doc.querySelectorAll(popSel))
          .filter((o) => (!indexApi || indexApi.isElementVisuallyVisible(o, { allowDisabled: true })) && !(o.closest && o.closest('#sleepwalker-host, #sleepwalker-ui-host')));
        optsList = visiblePopups.map((o) => ({
          element: o,
          disabled: Boolean(o.disabled || (o.getAttribute && o.getAttribute('aria-disabled') === 'true') || (o.classList && o.classList.contains('disabled'))),
          label: (o.innerText || o.textContent || (o.getAttribute && o.getAttribute('aria-label')) || '').replace(/\s+/g, ' ').trim(),
          value: (o.getAttribute && (o.getAttribute('data-value') || o.getAttribute('value'))) || (o.innerText || o.textContent || '').trim()
        })).filter((o) => o.label);
      }
      return optsList;
    };

    const observerRoot = (doc && doc.body) || el.parentElement || el;
    // Detect dynamically injected searchable input after opening custom dropdown
    if (!inputEl && doc && typeof doc.querySelector === 'function') {
      const findDynInput = () => {
        const scopes = [
          el.parentElement,
          el.closest && el.closest('[data-dropdown], .dropdown, .custom-select, .searchable-select'),
          doc.querySelector('[role="listbox"]:not([hidden]), .dropdown-menu.open, .dropdown-menu:not([hidden]), [role="dialog"]:not([hidden])')
        ].filter(Boolean);
        for (const sc of scopes) {
          const inp = sc.querySelector && sc.querySelector('input[type="search"], input[type="text"], input:not([type]), input[role="combobox"]');
          if (inp && (!indexApi || indexApi.isElementVisuallyVisible(inp))) return inp;
        }
        return null;
      };
      inputEl = await waitForDynamicDomChange(observerRoot, findDynInput, 220);
    }

    const isOrdinalQuery = /^(?:the\s+)?(?:first|1st|second|2nd|third|3rd|fourth|4th|fifth|5th)(?:\s+(?:one|option|choice|item))?$|^(?:number|option)\s*\d+$/i.test(String(rawInputValue || '').trim());
    if (inputEl && !isOrdinalQuery) {
      const filterStr = String(rawInputValue || '').trim();
      setNativeValue(inputEl, filterStr);
      dispatchControlEvents(inputEl, { includeBlur: false, includeKeyboard: true });
    }

    // Wait via scoped MutationObserver for async/dynamic options or filtered autocomplete results
    let liveOptions = await waitForDynamicDomChange(observerRoot, () => {
      const found = gatherVisibleOptions();
      return found.length > 0 ? found : null;
    }, opts.timeoutMs || 700);
    if (!liveOptions) liveOptions = gatherVisibleOptions();

    // If multi-word autocomplete query (e.g., "Berlin Germany" without comma) yielded 0 suggestions,
    // retry filtering by primary prefix token ("Berlin") and match the full label cleanly from rendered suggestions.
    if ((!liveOptions || liveOptions.length === 0) && inputEl && !isOrdinalQuery) {
      const firstTok = String(rawInputValue || '').trim().split(/[\s,]+/).find((t) => t.length >= 2) || '';
      if (firstTok && firstTok.length < String(rawInputValue || '').trim().length) {
        setNativeValue(inputEl, firstTok);
        dispatchControlEvents(inputEl, { includeBlur: false, includeKeyboard: true });
        liveOptions = await waitForDynamicDomChange(observerRoot, () => {
          const found = gatherVisibleOptions();
          return found.length > 0 ? found : null;
        }, opts.timeoutMs || 700);
        if (!liveOptions) liveOptions = gatherVisibleOptions();
      }
    }

    const match = matchChoiceOption(liveOptions, rawInputValue);
    if (match.status === 'ambiguous') {
      return { ok: false, status: 'ambiguous', candidates: match.candidates, error: `Multiple options match "${rawInputValue}".` };
    }
    if (match.status !== 'matched' || !match.option || !match.option.element) {
      return { ok: false, status: 'option_not_found', error: `Could not find option "${rawInputValue}" in ${fieldDescriptor.label}.` };
    }
    if (match.option.disabled) {
      return { ok: false, status: 'disabled', verified: false, error: `Option "${match.option.label}" in ${fieldDescriptor.label} is disabled.` };
    }

    const optEl = match.option.element;
    if (typeof optEl.dispatchEvent === 'function') {
      dispatchControlEvents(optEl, { includeClick: true, includeBlur: false });
    }
    if (typeof optEl.click === 'function') optEl.click();
    dispatchControlEvents(el, { includeBlur: true });
    await new Promise((r) => setTimeout(r, 35));

    const postState = indexApi && typeof indexApi.computeFieldState === 'function'
      ? indexApi.computeFieldState(fieldDescriptor)
      : { value: inputEl ? inputEl.value : (el.innerText || el.textContent || '').trim() };

    const targetLbl = (match.option.label || '').toLowerCase();
    const targetVal = (match.option.value || '').toLowerCase();
    const postVal = String(postState.value || '').toLowerCase();
    const triggerText = String((trigger && (trigger.innerText || trigger.textContent || trigger.value)) || '').replace(/\s+/g, ' ').trim().toLowerCase();
    const attrSel = optEl.getAttribute && (optEl.getAttribute('aria-selected') === 'true' || (optEl.classList && optEl.classList.contains('selected')));
    const verified = Boolean(
      attrSel ||
      (postVal && (postVal === targetLbl || postVal.includes(targetLbl) || targetLbl.includes(postVal) || (targetVal && postVal === targetVal))) ||
      (triggerText && (triggerText === targetLbl || triggerText.includes(targetLbl)))
    );
    if (!verified) {
      return {
        ok: false,
        verified: false,
        error: `Tried selecting "${match.option.label}" in ${fieldDescriptor.label}, but page shows "${postState.value || triggerText || 'empty'}".`
      };
    }

    return {
      ok: true,
      verified: true,
      appliedValue: match.option.label,
      actualState: postState,
      validationErrors: collectFieldValidationErrors(fieldDescriptor, doc)
    };
  }

  function buildNonSensitiveSummary(fields = []) {
    const summaryLines = [];
    const requiredMissing = [];
    let filledCount = 0;

    for (const f of fields) {
      if (f.sensitive) {
        if (f.done) filledCount += 1;
        else if (f.required) requiredMissing.push(f.label);
        summaryLines.push(`${f.label}: ${f.done ? '[entered manually — protected]' : '[not entered]'}`);
        continue;
      }
      if (f.done) {
        filledCount += 1;
        summaryLines.push(`${f.label}: ${f.stateText}`);
      } else if (f.required) {
        requiredMissing.push(f.label);
      }
    }

    return {
      totalCount: fields.length,
      filledCount,
      requiredMissing,
      lines: summaryLines
    };
  }

  const CARD_LIKE_RE = /^(?:\d[ -]*?){13,19}$/;

  function looksLikeSensitiveValue(rawVal) {
    const s = String(rawVal || '').trim();
    return Boolean(s && CARD_LIKE_RE.test(s));
  }

  /**
   * Universal single-field filler supporting native HTML5, React/Vue/Angular controlled inputs,
   * Google Forms JsAction/Wiz inputs, contenteditable, ARIA radiogroup/checkbox/listbox/combobox/switch/slider.
   * Enforces Sleepwalker's sensitive-field safety rule and performs post-fill read-back + validation checks.
   */
  async function fillFieldUniversal(fieldDescriptor, rawValue, opts = {}) {
    if (!fieldDescriptor || !fieldDescriptor.element) {
      return { ok: false, verified: false, status: 'target_missing', error: 'Field element unavailable.' };
    }
    const el = fieldDescriptor.element;
    const doc = (el && el.ownerDocument) || (typeof document !== 'undefined' ? document : null);
    const valStr = String(rawValue ?? '').trim();

    // Non-negotiable safety gate: never programmatically fill passwords, OTPs, CVVs, Aadhaar, PAN, or card numbers
    if (fieldDescriptor.sensitive || looksLikeSensitiveValue(valStr)) {
      try { if (typeof el.focus === 'function') el.focus(); } catch (_e) {}
      return {
        ok: false,
        verified: false,
        status: 'sensitive_blocked',
        label: fieldDescriptor.label,
        error: `Skipped sensitive field "${fieldDescriptor.label}". I'll leave this one for you.`
      };
    }

    if (fieldDescriptor.disabled || el.disabled || (el.getAttribute && el.getAttribute('aria-disabled') === 'true')) {
      return {
        ok: false,
        verified: false,
        status: 'disabled',
        label: fieldDescriptor.label,
        error: `Field "${fieldDescriptor.label}" is currently disabled.`
      };
    }

    if (typeof el.scrollIntoView === 'function') {
      try { el.scrollIntoView({ block: 'center', inline: 'center' }); } catch (_e) {}
    }
    highlightField(fieldDescriptor.clickTarget || el);

    const fType = String(fieldDescriptor.type || 'text').toLowerCase();

    // 1. Combobox / ARIA Listbox
    if (fType === 'combobox' || fType === 'listbox') {
      const res = await applyComboboxValue(fieldDescriptor, valStr, opts);
      return { ...res, label: fieldDescriptor.label, fieldType: fType };
    }

    // 2. Native <select>
    if (fType === 'select' || String(el.tagName || '').toUpperCase() === 'SELECT') {
      if (el.multiple) {
        const res = setSelectMultiple(el, valStr, { replace: Boolean(opts.replace) });
        return { ...res, label: fieldDescriptor.label, fieldType: 'select', validationErrors: collectFieldValidationErrors(fieldDescriptor, doc) };
      }
      const allOpts = Array.from(el.options || [])
        .filter((o) => String(o.value || '').trim() !== '' || String(o.textContent || '').trim() !== '')
        .map((o) => ({
          element: o,
          value: o.value,
          label: (o.textContent || o.label || o.value || '').replace(/\s+/g, ' ').trim(),
          disabled: Boolean(o.disabled)
        }));
      const match = matchChoiceOption(allOpts, valStr);
      if (match.status !== 'matched' || !match.option) {
        return { ok: false, verified: false, status: 'option_not_found', label: fieldDescriptor.label, error: `Could not find option "${valStr}" in "${fieldDescriptor.label}".` };
      }
      setNativeValue(el, match.option.value);
      dispatchControlEvents(el, { includeBlur: true });
      const verified = String(el.value) === String(match.option.value);
      return {
        ok: verified,
        verified,
        label: fieldDescriptor.label,
        fieldType: 'select',
        appliedValue: match.option.label,
        validationErrors: collectFieldValidationErrors(fieldDescriptor, doc)
      };
    }

    // 3. Radio group (native <input type="radio"> OR ARIA [role="radiogroup"] [role="radio"])
    if (fType === 'radio') {
      const match = matchChoiceOption(fieldDescriptor.options || [], valStr);
      if (match.status !== 'matched' || !match.option || !match.option.element) {
        return { ok: false, verified: false, status: 'option_not_found', label: fieldDescriptor.label, error: `Could not find option "${valStr}" in "${fieldDescriptor.label}".` };
      }
      const opt = match.option;
      const target = opt.clickTarget || opt.element;
      if (typeof target.click === 'function') target.click();
      const isNative = String(opt.element.tagName || '').toUpperCase() === 'INPUT';
      const checkedAfter = isNative
        ? Boolean(opt.element.checked)
        : (opt.element.getAttribute && opt.element.getAttribute('aria-checked') === 'true');
      if (!checkedAfter) {
        if (isNative) {
          opt.element.checked = true;
        } else if (typeof opt.element.setAttribute === 'function') {
          for (const sibling of (fieldDescriptor.options || [])) {
            if (sibling.element && typeof sibling.element.setAttribute === 'function') {
              sibling.element.setAttribute('aria-checked', sibling.element === opt.element ? 'true' : 'false');
            }
          }
        }
      }
      dispatchControlEvents(opt.element, { includeBlur: true });
      const verified = isNative
        ? Boolean(opt.element.checked)
        : (opt.element.getAttribute && opt.element.getAttribute('aria-checked') === 'true');
      return {
        ok: verified,
        verified,
        label: fieldDescriptor.label,
        fieldType: 'radio',
        appliedValue: opt.label,
        validationErrors: collectFieldValidationErrors(fieldDescriptor, doc)
      };
    }

    // 4. Checkbox group (native or ARIA [role="checkbox"] multi-select)
    if (fType === 'checkbox_group') {
      const targets = Array.isArray(rawValue)
        ? rawValue
        : valStr.split(/\s*(?:,|&|\band\b)\s*/i).map((x) => x.trim()).filter(Boolean);
      const selected = [];
      for (const t of targets) {
        const match = matchChoiceOption(fieldDescriptor.options || [], t);
        if (match.status === 'matched' && match.option && match.option.element) {
          const finalChecked = toggleBinaryElement(match.option.element, match.option.clickTarget || match.option.element, true);
          if (finalChecked) selected.push(match.option.label);
        }
      }
      if (selected.length === 0) {
        return { ok: false, verified: false, status: 'option_not_found', label: fieldDescriptor.label, error: `Could not match checkbox option "${valStr}" in "${fieldDescriptor.label}".` };
      }
      return {
        ok: true,
        verified: true,
        label: fieldDescriptor.label,
        fieldType: 'checkbox_group',
        appliedValue: selected.join(', '),
        validationErrors: collectFieldValidationErrors(fieldDescriptor, doc)
      };
    }

    // 5. Standalone checkbox or switch
    if (fType === 'checkbox' || fType === 'switch') {
      const wantOff = /^(?:false|no|off|0|uncheck|unchecked|disable|disabled)$/i.test(valStr);
      const desired = !wantOff;
      const finalChecked = toggleBinaryElement(el, fieldDescriptor.clickTarget || el, desired);
      return {
        ok: finalChecked === desired,
        verified: finalChecked === desired,
        label: fieldDescriptor.label,
        fieldType: fType,
        appliedValue: finalChecked ? (fType === 'switch' ? 'on' : 'checked') : (fType === 'switch' ? 'off' : 'unchecked'),
        validationErrors: collectFieldValidationErrors(fieldDescriptor, doc)
      };
    }

    // 6. Range / Slider
    if (fType === 'range' || fType === 'slider') {
      const res = setRangeValue(el, valStr);
      return { ...res, label: fieldDescriptor.label, fieldType: fType };
    }

    // 7. ContentEditable
    if (fType === 'contenteditable' || el.isContentEditable) {
      if (typeof el.focus === 'function') el.focus();
      el.textContent = valStr;
      dispatchControlEvents(el, { includeBlur: true, inputData: valStr });
      const actual = String(el.innerText || el.textContent || '').trim();
      return {
        ok: actual === valStr,
        verified: actual === valStr,
        label: fieldDescriptor.label,
        fieldType: 'contenteditable',
        appliedValue: actual,
        validationErrors: collectFieldValidationErrors(fieldDescriptor, doc)
      };
    }

    // 8. Text / Email / Tel / Number / Date / Textarea (controlled React/Vue/Angular/Google Forms safe)
    let normalizedVal = valStr;
    if (fType === 'date') {
      const parsed = parseSpokenDate(valStr, 'date');
      if (parsed) normalizedVal = parsed;
    } else if (fType === 'email' && /\s+(?:at\s+the\s+rate|at|dot)\s+/i.test(valStr)) {
      normalizedVal = parseSpokenEmail(valStr);
    }

    if (typeof el.focus === 'function') el.focus();
    setNativeValue(el, normalizedVal);
    dispatchControlEvents(el, { includeBlur: true, inputData: normalizedVal });
    const actual = String(el.value ?? '');
    const verified = actual === normalizedVal || actual.trim() === normalizedVal.trim();
    return {
      ok: verified,
      verified,
      label: fieldDescriptor.label,
      fieldType: fType,
      appliedValue: actual,
      validationErrors: collectFieldValidationErrors(fieldDescriptor, doc)
    };
  }

  /**
   * Batch multi-field form filler (inspired by nanobrowser's fill_form receipts pattern):
   * Indexes all visible fields once, matches each requested { label, value } pair,
   * fills in DOM order with per-field read-back & validation receipts, never auto-submits.
   */
  async function fillFormBatch(entries = [], doc = (typeof document !== 'undefined' ? document : null), opts = {}) {
    const indexApi = getFormIndexApi();
    const fields = indexApi && typeof indexApi.buildFormIndex === 'function'
      ? indexApi.buildFormIndex(doc)
      : [];
    const receipts = [];
    const usedIds = new Set();

    const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    const findBestField = (labelQuery) => {
      const q = norm(labelQuery);
      if (!q) return null;
      const qTokens = q.split(/\s+/).filter(Boolean);
      let best = null;
      let bestScore = 0;
      for (const f of fields) {
        if (usedIds.has(f.id)) continue;
        const lbl = norm(f.label);
        const full = norm(f.fullLabel);
        const name = norm(f.name);
        let s = 0;
        if (lbl === q || full === q || (name && name === q)) s = 1.0;
        else if (lbl.startsWith(q) || q.startsWith(lbl)) s = 0.9;
        else if (lbl.includes(q) || full.includes(q)) s = 0.82;
        else if (q.includes(lbl) && lbl.length >= 3) s = 0.78;
        else if (qTokens.length > 0) {
          const hits = qTokens.filter((t) => lbl.includes(t) || full.includes(t)).length;
          if (hits > 0) s = (hits / qTokens.length) * 0.75;
        }
        if (s > bestScore) {
          bestScore = s;
          best = f;
        }
      }
      return bestScore >= 0.45 ? best : null;
    };

    for (const entry of (entries || [])) {
      const targetLabel = String(entry && entry.label || '').trim();
      const targetValue = entry && entry.value;
      const matched = findBestField(targetLabel);
      if (!matched) {
        receipts.push({
          ok: false,
          verified: false,
          status: 'target_not_found',
          requestedLabel: targetLabel,
          error: `No matching form field found for "${targetLabel}".`
        });
        continue;
      }
      usedIds.add(matched.id);
      const r = await fillFieldUniversal(matched, targetValue, opts);
      receipts.push({
        ...r,
        requestedLabel: targetLabel,
        fieldId: matched.id
      });
    }

    // Recompute summary after batch fill
    const refreshed = indexApi && typeof indexApi.buildFormIndex === 'function'
      ? indexApi.buildFormIndex(doc)
      : fields;
    const summary = buildNonSensitiveSummary(refreshed);
    const filledCount = receipts.filter((r) => r.ok).length;
    const failedCount = receipts.filter((r) => !r.ok).length;
    const sensitiveBlockedCount = receipts.filter((r) => r.status === 'sensitive_blocked').length;

    return {
      ok: filledCount > 0 && failedCount === 0,
      partial: filledCount > 0 && failedCount > 0,
      filledCount,
      failedCount,
      sensitiveBlockedCount,
      totalRequested: (entries || []).length,
      receipts,
      summary,
      submitted: false
    };
  }

  return {
    transliterateDevanagariToLatin,
    hasDevanagari,
    parseSpokenNumbers,
    parseSpokenDate,
    parseSpokenEmail,
    formatPhoneReadback,
    matchChoiceOption,
    highlightField,
    setNativeValue,
    waitForDynamicDomChange,
    disconnectAllObservers,
    dispatchControlEvents,
    collectFieldValidationErrors,
    toggleBinaryElement,
    setSelectMultiple,
    setRangeValue,
    applyComboboxValue,
    fillFieldUniversal,
    fillFormBatch,
    buildNonSensitiveSummary
  };
});
