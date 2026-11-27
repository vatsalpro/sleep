/**
 * Sleepwalker - match.js
 * Cross-script phonetic + token/stem/synonym + context scoring engine (0-LLM).
 * Supports Devanagari <-> Latin consonant skeletons, spelled letters ("a b c" / "ए बी सी"),
 * MORE_INFO context boosting on generic links, and unambiguous decision thresholds.
 */
(function (root) {
  'use strict';

  const DEVANAGARI_RE = /[\u0900-\u097F]/;

  const NOISE_WORDS = new Set([
    'click', 'open', 'press', 'tap', 'select', 'go', 'take', 'find', 'locate',
    'link', 'links', 'button', 'btn', 'tab', 'tabs', 'menu', 'menuitem', 'item', 'option',
    'please', 'can', 'you', 'want', 'more', 'about',
    'tell', 'me', 'learn', 'here', 'it',
    'kholo', 'kholna', 'dabao', 'karo', 'jao', 'chalo', 'dhundo', 'kahan', 'hai', 'dikhao',
    'batao', 'aur', 'ke', 'baare', 'mein', 'jaankari', 'chahiye',
    'par', 'ko', 'ka', 'ki', 'the', 'a', 'an', 'to', 'on', 'in', 'of', 'for', 'zara', 'ek',
    'wala', 'wali', 'wale',
    'लिंक', 'बटन', 'क्लिक', 'खोलो', 'खोलना', 'दबाओ', 'करो', 'ओपन', 'ढूंढो', 'दिखाओ', 'बताओ',
    'जाओ', 'कहाँ', 'है', 'और', 'के', 'बारे', 'में', 'जानकारी', 'चाहिए', 'ज़रा', 'जरा',
    'पर', 'को', 'का', 'की', 'वाला', 'वाली', 'वाले'
  ]);

  // Used for label normalization (keep content words intact, strip UI wrapper articles/particles).
  const LABEL_STRIP_WORDS = new Set([
    'click', 'open', 'link', 'button', 'btn', 'tab', 'tabs', 'menu', 'menuitem', 'item', 'option',
    'the', 'a', 'an', 'to', 'on', 'of', 'in', 'us',
    'kholo', 'kholna', 'dabao', 'karo', 'par', 'ko', 'ka', 'ki', 'wala', 'wali',
    'लिंक', 'बटन', 'क्लिक', 'खोलो', 'दबाओ', 'करो', 'पर', 'को', 'का', 'की'
  ]);

  // Hindi/English spoken letter names ("ए बी सी" <-> "a b c" <-> "abc")
  const DEVANAGARI_LETTER_NAMES = {
    'ए': 'a', 'अ': 'a',
    'बी': 'b',
    'सी': 'c', 'सि': 'c',
    'डी': 'd', 'डि': 'd',
    'ई': 'e', 'इ': 'e',
    'एफ': 'f', 'ऐफ': 'f',
    'जी': 'g', 'जि': 'g',
    'एच': 'h',
    'आई': 'i', 'आइ': 'i',
    'जे': 'j',
    'के': 'k',
    'एल': 'l',
    'एम': 'm',
    'एन': 'n',
    'ओ': 'o',
    'पी': 'p', 'पि': 'p',
    'क्यू': 'q', 'क्यु': 'q',
    'आर': 'r',
    'एस': 's',
    'टी': 't', 'टि': 't',
    'यू': 'u', 'यु': 'u',
    'वी': 'v', 'वि': 'v', 'भी': 'v',
    'डब्ल्यू': 'w', 'डब्लू': 'w',
    'एक्स': 'x', 'ऐक्स': 'x',
    'वाई': 'y', 'वाइ': 'y',
    'जेड': 'z', 'ज़ेड': 'z', 'जड': 'z'
  };

  // Synonym groups anchored to canonical token tags
  const SYNONYM_MAP = {
    info: 'syn_info',
    information: 'syn_info',
    detail: 'syn_info',
    details: 'syn_info',
    jaankari: 'syn_info',
    जानकारी: 'syn_info',
    विवरण: 'syn_info',

    contact: 'syn_contact',
    reach: 'syn_contact',
    contactus: 'syn_contact',
    reachus: 'syn_contact',
    sampark: 'syn_contact',
    संपर्क: 'syn_contact',

    apply: 'syn_apply',
    register: 'syn_apply',
    registration: 'syn_apply',
    signup: 'syn_apply',
    enroll: 'syn_apply',
    enrol: 'syn_apply',
    आवेदन: 'syn_apply',

    login: 'syn_login',
    signin: 'syn_login',
    logon: 'syn_login',
    sign: 'syn_login',
    लॉगिन: 'syn_login',

    national: 'syn_national',
    राष्ट्रीय: 'syn_national',

    fee: 'syn_fee',
    fees: 'syn_fee',
    tuition: 'syn_fee',
    payment: 'syn_fee',
    फीस: 'syn_fee',
    शुल्क: 'syn_fee',

    doc: 'syn_docs',
    docs: 'syn_docs',
    documentation: 'syn_docs',
    manual: 'syn_docs',
    reference: 'syn_docs'
  };

  const GENERIC_MORE_INFO_RE = /^(?:read\s+more|learn\s+more|more\s+info(?:rmation)?|more\s+details?|details?|know\s+more|click\s+here|view(?:\s+more|\s+details)?|see\s+more|explore|आगे\s+पढ़ें|और\s+जानें|अधिक\s+जानें|विवरण|और\s+देखें)$/i;

  const LABIAL_DEVANAGARI_RE = /^[पफबभम\u095E]/;

  const DEVANAGARI_CONJUNCTS = [
    ['क्ष', 'ksh'],
    ['त्र', 'tr'],
    ['ज्ञ', 'gy'],
    ['क़', 'k'],
    ['\u0958', 'k'],
    ['ख़', 'kh'],
    ['\u0959', 'kh'],
    ['ग़', 'g'],
    ['\u095A', 'g'],
    ['ज़', 'j'],
    ['\u095B', 'j'],
    ['फ़', 'f'],
    ['\u095E', 'f'],
    ['ड़', 'r'],
    ['\u095C', 'r'],
    ['ढ़', 'rh'],
    ['\u095D', 'rh'],
    ['य़', 'y'],
    ['\u095F', 'y']
  ];

  const DEVANAGARI_CHARS = {
    'क': 'k', 'ख': 'kh', 'ग': 'g', 'घ': 'gh', 'ङ': 'n',
    'च': 'ch', 'छ': 'chh', 'ज': 'j', 'झ': 'jh', 'ञ': 'n',
    'ट': 't', 'ठ': 'th', 'ड': 'd', 'ढ': 'dh', 'ण': 'n',
    'त': 't', 'थ': 'th', 'द': 'd', 'ध': 'dh', 'न': 'n',
    'प': 'p', 'फ': 'f', 'ब': 'b', 'भ': 'bh', 'म': 'm',
    'य': 'y', 'र': 'r', 'ल': 'l', 'ळ': 'l', 'व': 'v',
    'श': 'sh', 'ष': 'sh', 'स': 's', 'ह': 'h',
    'ऋ': 'r', 'ॠ': 'r', 'ृ': 'r', 'ॄ': 'r'
  };

  const DEVANAGARI_DROP_RE = /[\u0901\u0903\u0904-\u090A\u090C-\u0914\u093A-\u0942\u0945-\u094F\u0955-\u0957\u0962-\u0963\u0972-\u0977]/g;

  const DEVANAGARI_DIGITS = {
    '०': '0', '१': '1', '२': '2', '३': '3', '४': '4',
    '५': '5', '६': '6', '७': '7', '८': '8', '९': '9'
  };

  const ORDINAL_MAP = {
    '1': 1, '1st': 1, 'one': 1, 'first': 1, 'ek': 1, 'एक': 1,
    'pehla': 1, 'pahla': 1, 'pehle': 1, 'pahle': 1, 'pahli': 1, 'pehli': 1,
    'पहला': 1, 'पहली': 1, 'पहले': 1, 'फर्स्ट': 1,
    '2': 2, '2nd': 2, 'two': 2, 'second': 2, 'do': 2, 'दो': 2,
    'doosra': 2, 'dusra': 2, 'doosri': 2, 'dusri': 2,
    'दूसरा': 2, 'दूसरी': 2, 'दूसरे': 2, 'सेकंड': 2,
    '3': 3, '3rd': 3, 'three': 3, 'third': 3, 'teen': 3, 'तीन': 3,
    'teesra': 3, 'tisra': 3, 'teesri': 3, 'tisri': 3,
    'तीसरा': 3, 'तीसरी': 3, 'तीसरे': 3, 'थर्ड': 3,
    '4': 4, '4th': 4, 'four': 4, 'fourth': 4, 'char': 4, 'chaar': 4, 'चार': 4,
    'chautha': 4, 'chauthi': 4, 'चौथा': 4, 'चौथी': 4, 'चौथे': 4, 'फोर्थ': 4,
    '5': 5, '5th': 5, 'five': 5, 'fifth': 5,
    'paanch': 5, 'panch': 5, 'पांच': 5, 'पाँच': 5,
    'paanchva': 5, 'paanchwa': 5, 'panchva': 5, 'panchwa': 5,
    'पांचवा': 5, 'पाँचवा': 5, 'पांचवां': 5, 'पाँचवां': 5, 'पांचवी': 5, 'पाँचवी': 5, 'फिफ्थ': 5
  };

  function normalizeTextBase(text) {
    let s = String(text || '').normalize('NFC').toLowerCase();
    s = s.replace(/[०-९]/g, (d) => DEVANAGARI_DIGITS[d] || d);
    // Join intra-word hyphens ("To-Morrow" -> "tomorrow") BEFORE stripping standalone "to".
    s = s.replace(/([a-z0-9\u0900-\u097F])-([a-z0-9\u0900-\u097F])/g, '$1$2');
    s = s.replace(/[^a-z0-9\u0900-\u097F\s]/g, ' ');
    s = s.replace(/\s+/g, ' ').trim();
    return s;
  }

  /**
   * Collapse spelled-out letter sequences ("a b c" -> "abc", "ए बी सी" -> "abc") while keeping normal words intact.
   */
  function normalizeSpelledLetters(text) {
    const base = normalizeTextBase(text);
    if (!base) return '';
    const tokens = base.split(' ').filter(Boolean);
    const mapped = tokens.map((tok) => {
      if (Object.prototype.hasOwnProperty.call(DEVANAGARI_LETTER_NAMES, tok)) {
        return { letter: DEVANAGARI_LETTER_NAMES[tok], orig: tok, isSingle: true };
      }
      if (/^[a-z]$/.test(tok)) {
        return { letter: tok, orig: tok, isSingle: true };
      }
      return { letter: null, orig: tok, isSingle: false };
    });

    const out = [];
    let run = '';
    let runOrig = [];
    const flushRun = () => {
      if (!run) return;
      if (runOrig.length >= 2) {
        out.push(run);
      } else {
        out.push(runOrig[0]);
      }
      run = '';
      runOrig = [];
    };

    for (let i = 0; i < mapped.length; i++) {
      const m = mapped[i];
      if (m.isSingle) {
        run += m.letter;
        runOrig.push(m.orig);
      } else {
        flushRun();
        out.push(m.orig);
      }
    }
    flushRun();
    return out.join(' ');
  }

  function stripCommandNoise(text, wordSet = NOISE_WORDS) {
    let s = normalizeSpelledLetters(text);
    if (!s) return [];
    s = s.replace(/\s+(?:open\s+karo|open\s+kar\s+do|click\s+kar\s+do|kar\s+do|ओपन\s+करो|कर\s+दो)$/i, '').trim();
    const rawTokens = s.split(' ').filter(Boolean);
    const filtered = rawTokens.filter((tok) => !wordSet.has(tok));
    return filtered.length > 0 ? filtered : rawTokens;
  }

  function transliterateDevanagari(token) {
    let out = '';
    let i = 0;
    while (i < token.length) {
      let matched = false;
      for (let c = 0; c < DEVANAGARI_CONJUNCTS.length; c++) {
        const [seq, repl] = DEVANAGARI_CONJUNCTS[c];
        if (token.startsWith(seq, i)) {
          out += repl;
          i += seq.length;
          matched = true;
          break;
        }
      }
      if (matched) continue;

      const ch = token[i];
      if (ch === '\u0902') {
        const next = token.slice(i + 1);
        out += LABIAL_DEVANAGARI_RE.test(next) ? 'm' : 'n';
        i += 1;
        continue;
      }
      if (Object.prototype.hasOwnProperty.call(DEVANAGARI_CHARS, ch)) {
        out += DEVANAGARI_CHARS[ch];
        i += 1;
        continue;
      }
      if (DEVANAGARI_DROP_RE.test(ch)) {
        DEVANAGARI_DROP_RE.lastIndex = 0;
        i += 1;
        continue;
      }
      DEVANAGARI_DROP_RE.lastIndex = 0;
      if (/[a-z0-9]/.test(ch)) out += ch;
      i += 1;
    }
    return out;
  }

  function tokenToSkeleton(token) {
    if (!token) return '';
    let w = DEVANAGARI_RE.test(token) ? transliterateDevanagari(token) : token.toLowerCase();

    w = w.replace(/(?:o|a|e)w(?=$|[^aeiouy])/g, '');
    w = w
      .replace(/([aeiou])sion/g, '$1jn')
      .replace(/([^s])tion/g, '$1shn')
      .replace(/sion/g, 'shn')
      .replace(/^tech/g, 'tek')
      .replace(/ch(?=[nrl])/g, 'k')
      .replace(/g(?=y$|ies?$|ical)/g, 'j')
      .replace(/igh(?=$|t|[^a-z])/g, 'i')
      .replace(/gn$/g, 'n')
      .replace(/^sch(?=[aeiouy])/g, 'sk')
      .replace(/tch/g, 'ch')
      .replace(/dge$/g, 'j')
      .replace(/ge$/g, 'j');

    w = w
      .replace(/sh/g, '\u0001')
      .replace(/ch/g, '\u0002')
      .replace(/kh/g, '\u0003')
      .replace(/gh/g, '\u0004')
      .replace(/th/g, 't')
      .replace(/ph/g, 'f')
      .replace(/qu(?=[aeiouy])/g, 'kv')
      .replace(/c(?=[eiy])/g, 's')
      .replace(/[cq]/g, 'k')
      .replace(/x/g, 'ks')
      .replace(/w/g, 'v');

    w = w.replace(/[aeiouyh]/g, '');
    w = w
      .replace(/\u0001/g, 'sh')
      .replace(/\u0002/g, 'ch')
      .replace(/\u0003/g, 'kh')
      .replace(/\u0004/g, 'gh');

    w = w.replace(/(.)\1+/g, '$1');
    return w;
  }

  function phoneticTokens(text, wordSet = NOISE_WORDS) {
    const tokens = stripCommandNoise(text, wordSet);
    const out = [];
    for (let i = 0; i < tokens.length; i++) {
      const sk = tokenToSkeleton(tokens[i]);
      if (sk) {
        out.push(sk);
      } else {
        const rawAlnum = tokens[i].replace(/[^a-z0-9]/g, '');
        if (rawAlnum) out.push(rawAlnum);
      }
    }
    return out;
  }

  function phoneticKey(text) {
    const toks = phoneticTokens(text, LABEL_STRIP_WORDS);
    if (toks.length > 0) return toks.join('');
    return normalizeTextBase(text).replace(/[^a-z0-9]/g, '');
  }

  /**
   * Space-separated consonant skeleton units ("Tomorrow Show" & "टुमारो शो" -> "t m r sh").
   */
  function phoneticSkeleton(text) {
    const key = phoneticKey(text);
    const units = [];
    let i = 0;
    while (i < key.length) {
      const two = key.slice(i, i + 2);
      if (two === 'sh' || two === 'ch' || two === 'kh' || two === 'gh') {
        units.push(two);
        i += 2;
      } else {
        units.push(key[i]);
        i += 1;
      }
    }
    return units.join(' ');
  }

  function editDistance(a, b) {
    const s = String(a || '');
    const t = String(b || '');
    if (s === t) return 0;
    const m = s.length;
    const n = t.length;
    if (m === 0) return n;
    if (n === 0) return m;
    const dp = new Array(n + 1);
    for (let j = 0; j <= n; j++) dp[j] = j;
    for (let i = 1; i <= m; i++) {
      let prev = dp[0];
      dp[0] = i;
      for (let j = 1; j <= n; j++) {
        const tmp = dp[j];
        if (s[i - 1] === t[j - 1]) {
          dp[j] = prev;
        } else {
          dp[j] = 1 + Math.min(prev, dp[j], dp[j - 1]);
        }
        prev = tmp;
      }
    }
    return dp[n];
  }

  /**
   * Light stemming + synonym canonicalization for token overlap matching.
   */
  function stemToken(token) {
    let t = String(token || '').normalize('NFC').toLowerCase().trim();
    if (!t) return '';
    if (Object.prototype.hasOwnProperty.call(SYNONYM_MAP, t)) return SYNONYM_MAP[t];

    if (/^[a-z]{4,}$/.test(t)) {
      if (t.endsWith('ies') && t.length >= 5) {
        t = `${t.slice(0, -3)}y`;
      } else if (t.endsWith('ing') && t.length >= 6) {
        t = t.slice(0, -3);
        if (t.length >= 4 && t[t.length - 1] === t[t.length - 2]) t = t.slice(0, -1);
      } else if (t.endsWith('ed') && t.length >= 5) {
        t = t.slice(0, -2);
        if (t.length >= 4 && t[t.length - 1] === t[t.length - 2]) t = t.slice(0, -1);
      } else if (t.endsWith('es') && t.length >= 5 && !/(ss|us|is)$/.test(t)) {
        t = t.slice(0, -2);
      } else if (t.endsWith('s') && t.length >= 4 && !/(ss|us|is)$/.test(t)) {
        t = t.slice(0, -1);
      }
    }
    return Object.prototype.hasOwnProperty.call(SYNONYM_MAP, t) ? SYNONYM_MAP[t] : t;
  }

  function stemmedTokens(text, useLabelStrip = true) {
    const rawNoStrip = stripCommandNoise(text, new Set(['the', 'a', 'an']));
    const raw = stripCommandNoise(text, useLabelStrip ? LABEL_STRIP_WORDS : NOISE_WORDS);
    const joinedAll = rawNoStrip.join('');
    const toks = raw.map(stemToken).filter(Boolean);
    if (Object.prototype.hasOwnProperty.call(SYNONYM_MAP, joinedAll)) {
      return [SYNONYM_MAP[joinedAll]];
    }
    for (let i = 0; i < rawNoStrip.length - 1; i++) {
      const bi = `${rawNoStrip[i]}${rawNoStrip[i + 1]}`;
      if (Object.prototype.hasOwnProperty.call(SYNONYM_MAP, bi)) {
        toks.push(SYNONYM_MAP[bi]);
      }
    }
    return Array.from(new Set(toks));
  }

  function phoneticTokenMatched(qt, candTokens) {
    for (let i = 0; i < candTokens.length; i++) {
      const ct = candTokens[i];
      if (qt === ct) return { matched: true, exact: true };
      if (qt.length >= 4 && ct.length >= 4 && editDistance(qt, ct) <= 1) {
        return { matched: true, exact: false };
      }
      if (qt.length >= 3 && ct.length >= 3 && (ct.includes(qt) || qt.includes(ct))) {
        return { matched: true, exact: false };
      }
    }
    return { matched: false, exact: false };
  }

  /**
   * Score a query string against a single text field (label, ariaLabel, title, or hrefWords) on 0..1 scale.
   */
  function scoreFieldText(query, fieldText, options = {}) {
    // Fast-path exact raw label match after stripping leading/trailing EN+HI action wrappers
    // (handles labels containing numbers/commas/noise words like "0 items in cart", "Sign in खोलो", "Click here to Login in application")
    const qRawClean = String(query || '').normalize('NFC').toLowerCase()
      .replace(/^(?:open|click|tap|press|select|choose|go\s+to)\s+/i, '')
      .replace(/\s+(?:kholo|dabao|chuno|click\s+karo|open\s+karo|खोलो|दबाओ|चुनो|क्लिक\s+करो)$/i, '')
      .replace(/\s+/g, ' ')
      .trim();
    const fRawClean = String(fieldText || '').normalize('NFC').toLowerCase().replace(/\s+/g, ' ').trim();
    if (qRawClean && fRawClean) {
      if (qRawClean === fRawClean) return 1.0;
      if (qRawClean.length >= 4 && fRawClean.includes(qRawClean)) {
        return Math.min(0.95, 0.80 + (qRawClean.length / Math.max(fRawClean.length, 1)) * 0.15);
      }
    }

    const useFullQueryStrip = options.stripQueryNoise !== false;
    const qNorm = stripCommandNoise(query, useFullQueryStrip ? NOISE_WORDS : LABEL_STRIP_WORDS).join(' ');
    const qRawSpelled = normalizeSpelledLetters(query);
    const fRawSpelled = normalizeSpelledLetters(fieldText);
    const fNorm = stripCommandNoise(fieldText, LABEL_STRIP_WORDS).join(' ');
    const qStr = qNorm || qRawSpelled;
    if (!qStr || (!fNorm && !fRawSpelled)) return 0;

    // (a) Exact or contained normalized / spelled-letter match
    let aScore = 0;
    const fWordsCount = fNorm ? fNorm.split(' ').filter(Boolean).length : 0;
    if (fRawSpelled && qRawSpelled === fRawSpelled) aScore = 1.0;
    else if (fNorm && qStr === fNorm) aScore = 0.96;
    else if (fNorm && qStr.length >= 3 && fNorm.startsWith(`${qStr} `) && fWordsCount <= 2) {
      aScore = 0.87;
    } else if (fNorm && qStr.length >= 3 && fNorm.includes(qStr)) {
      const ratio = qStr.length / Math.max(fNorm.length, 1);
      aScore = Math.min(0.92, 0.68 + ratio * 0.24);
    } else if (fNorm && fNorm.length >= 3 && qStr.includes(fNorm)) {
      aScore = 0.76;
    }

    // (b) Token overlap with light stemming, synonyms & cross-script per-token phonetic match
    let bScore = 0;
    const qStems = stemmedTokens(query, !useFullQueryStrip);
    const fStems = stemmedTokens(fieldText, true);
    if (qStems.length > 0 && fStems.length > 0) {
      let exactHits = 0;
      let fuzzyHits = 0;
      for (let i = 0; i < qStems.length; i++) {
        const qs = qStems[i];
        if (fStems.includes(qs)) {
          exactHits += 1;
        } else {
          const qSk = phoneticKey(qs);
          const hasStemFuzzy = !DEVANAGARI_RE.test(qs) && fStems.some((fs) => fs.length >= 4 && qs.length >= 4 && editDistance(qs, fs) <= 1);
          const hasPhoneticExact = Boolean(qSk) && fStems.some((fs) => {
            const fSk = phoneticKey(fs);
            return Boolean(fSk) && qSk === fSk;
          });
          const hasPhoneticFuzzy = !hasPhoneticExact && Boolean(qSk) && qSk.length >= 4 && fStems.some((fs) => {
            const fSk = phoneticKey(fs);
            return Boolean(fSk) && fSk.length >= 4 && editDistance(qSk, fSk) <= 1;
          });
          if (hasPhoneticExact) exactHits += 0.96;
          else if (hasStemFuzzy || hasPhoneticFuzzy) fuzzyHits += 0.78;
        }
      }
      const totalHits = exactHits + fuzzyHits;
      if (totalHits > 0) {
        const qCov = Math.min(1, totalHits / qStems.length);
        const fCov = Math.min(1, totalHits / fStems.length);
        if (exactHits >= qStems.length * 0.95 && fCov >= 0.94) {
          bScore = 0.91;
        } else if (exactHits >= qStems.length * 0.95) {
          bScore = Math.min(0.89, 0.72 + 0.17 * fCov);
        } else {
          bScore = 0.50 * qCov + 0.22 * qCov * fCov;
        }
      }
    }

    // (c) Phonetic consonant skeleton & edit distance <= 1 for 4+ char skeletons
    let cScore = 0;
    const qKey = phoneticKey(qStr);
    const cKey = phoneticKey(fNorm || fRawSpelled);
    const qToks = phoneticTokens(qStr, LABEL_STRIP_WORDS);
    const cToks = phoneticTokens(fNorm || fRawSpelled, LABEL_STRIP_WORDS);

    if (qKey && cKey) {
      if (qKey === cKey) {
        cScore = 0.92;
      } else {
        const minLen = Math.min(qKey.length, cKey.length);
        const dist = editDistance(qKey, cKey);
        if (minLen >= 4 && dist <= 1) {
          cScore = 0.86;
        }
      }
    }

    if (qToks.length > 0 && cToks.length > 0) {
      let exactTok = 0;
      let fuzzyTok = 0;
      let hasLongExact = false;
      for (let i = 0; i < qToks.length; i++) {
        const hit = phoneticTokenMatched(qToks[i], cToks);
        if (hit.matched) {
          if (hit.exact) {
            exactTok += 1;
            if (qToks[i].length >= 5) hasLongExact = true;
          } else {
            fuzzyTok += 1;
          }
        }
      }
      const total = exactTok + fuzzyTok * 0.85;
      if (total > 0) {
        const qCov = total / qToks.length;
        const cCov = total / cToks.length;
        let ts = 0;
        if (qCov >= 1 && cCov >= 1) ts = exactTok === qToks.length ? 0.92 : 0.86;
        else if (qCov >= 1) ts = Math.min(0.79, 0.62 + 0.14 * cCov);
        else ts = (hasLongExact ? 0.56 : 0.44) * qCov * (0.5 + 0.5 * cCov) + (hasLongExact ? 0.22 : 0);
        if (ts > cScore) cScore = ts;
      }
    }

    if (qKey && cKey && qKey !== cKey) {
      if (qKey.length >= 3 && cKey.includes(qKey)) {
        const sub = Math.min(0.72, 0.54 + (qKey.length / Math.max(cKey.length, 1)) * 0.16);
        if (sub > cScore) cScore = sub;
      } else if (cKey.length >= 3 && qKey.includes(cKey)) {
        const sub = Math.min(0.68, 0.50 + (cKey.length / Math.max(qKey.length, 1)) * 0.15);
        if (sub > cScore) cScore = sub;
      }
    }

    return Math.min(1.0, Math.max(aScore, bScore, cScore));
  }

  function splitScopedLinkTarget(rawTarget, explicitSpec = {}) {
    let target = String(rawTarget || '')
      .replace(/^(?:please\s+)?(?:open|click|press|tap|select|go\s+to)\s+/i, '')
      .replace(/\s+(?:kholo|kholna|dabao|karo|open\s+karo|click\s+karo|खोलो|खोलना|दबाओ|करो|क्लिक\s+करो)$/i, '')
      .trim();
    let sectionFilter = String(explicitSpec.section || explicitSpec.sectionFilter || '').trim();
    let linkPreference = String(explicitSpec.linkPreference || '').trim().toLowerCase();
    let inferredSection = false;

    if (!sectionFilter && target) {
      const m = target.match(/^(.+?)\s+(?:under|inside|within|in\s+the|in|below|from)\s+(?:the\s+)?(.+?)(?:\s+(?:section|heading|list|card|table|category))?$/i);
      if (m && m[1].trim().length >= 2 && m[2].trim().length >= 2) {
        const rhs = m[2].trim();
        // Avoid splitting genuine entity names like "Sign in", "Log in", "Terms of use"
        if (!/^(?:all|english|hindi|chrome|google|menu|header|footer|main|page)$/i.test(rhs)) {
          target = m[1].trim();
          sectionFilter = rhs;
          inferredSection = true;
        }
      }
    }

    if (!linkPreference && target) {
      if (/\b(?:official(?:\s+(?:site|website|page|link|docs?|documentation))?|original\s+site)\b/i.test(target)) {
        linkPreference = /\bdocs?|documentation\b/i.test(target) ? 'documentation' : 'official';
      } else if (/\b(?:docs|documentation|api\s+reference)\b/i.test(target)) {
        linkPreference = 'documentation';
      } else if (/\b(?:tutorial|blog|forum|reddit)\b/i.test(target)) {
        linkPreference = 'tutorial';
      }
      if (linkPreference === 'official' || linkPreference === 'documentation') {
        const cleaned = target
          .replace(/\b(?:the|an?|official|original|link|website|site|page)\b/gi, ' ')
          .replace(/\s+/g, ' ')
          .trim();
        if (cleaned.length >= 2) target = cleaned;
      }
    }

    return { cleanTarget: target, sectionFilter, inferredSection, linkPreference };
  }

  /**
   * Score an indexed target object (or string) against querySpec ({ target, action, area, ordinal, section, linkPreference }).
   * Combines a..e max score plus f) gentle viewport/main/area/position/section/official boosts on 0..1 scale.
   */
  function scoreTarget(targetItem, querySpec = {}) {
    const spec = typeof querySpec === 'string' ? { target: querySpec } : (querySpec || {});
    const targetObj = typeof targetItem === 'string' ? { label: targetItem } : (targetItem || {});
    const scoped = splitScopedLinkTarget(spec.target, spec);
    const label = String(targetObj.label || '');
    // If the unsplit query directly matches the element's own label (e.g. "0 items in cart",
    // "Click here to Login in application", "Hello, sign in Account & Lists"), don't let an
    // inferred "in/from/under" section split penalize an exact label match.
    const directLabelScore = (scoped.inferredSection && spec.target && label)
      ? scoreFieldText(spec.target, label)
      : 0;
    const rawTargetText = directLabelScore >= 0.85 ? String(spec.target || '').trim() : scoped.cleanTarget;
    const sectionFilter = directLabelScore >= 0.85 ? '' : scoped.sectionFilter;
    const linkPreference = scoped.linkPreference;
    const action = String(spec.action || 'CLICK').toUpperCase();

    if (!label && !targetObj.ariaLabel && !targetObj.title && !targetObj.hrefWords) {
      return { score: 0, baseScore: 0, genericMoreInfo: false };
    }

    if (Array.isArray(spec.excludeHrefs) && targetObj.href && spec.excludeHrefs.includes(targetObj.href)) {
      return { score: 0, baseScore: 0, genericMoreInfo: false };
    }
    if (Array.isArray(spec.excludeLabels) && label && spec.excludeLabels.some((x) => String(x).toLowerCase() === label.toLowerCase())) {
      return { score: 0, baseScore: 0, genericMoreInfo: false };
    }

    if (!rawTargetText) {
      const posScore = _scoreAreaAndPositionOnly(targetObj, spec);
      return { score: posScore, baseScore: posScore, genericMoreInfo: false };
    }

    const labelScore = scoreFieldText(rawTargetText, label);
    const ariaScore = targetObj.ariaLabel && targetObj.ariaLabel !== label
      ? scoreFieldText(rawTargetText, targetObj.ariaLabel) * 0.98
      : 0;
    const titleScore = targetObj.title && targetObj.title !== label
      ? scoreFieldText(rawTargetText, targetObj.title) * 0.94
      : 0;
    const domainMetaText = [targetObj.hrefWords || '', targetObj.domain || '', targetObj.category || ''].filter(Boolean).join(' ');
    const hrefScore = domainMetaText
      ? scoreFieldText(rawTargetText, domainMetaText) * 0.94
      : 0;

    // Context matching (e)
    const contextHeading = String(targetObj.contextHeading || '');
    const sectionPathText = String(targetObj.sectionPathText || '');
    const listContext = String(targetObj.listContext || '');
    const tableText = targetObj.tableContext
      ? [targetObj.tableContext.caption || '', targetObj.tableContext.colHeader || '', targetObj.tableContext.rowText || ''].filter(Boolean).join(' ')
      : '';
    const contextFull = String(targetObj.context || '');
    const headingMatch = contextHeading ? scoreFieldText(rawTargetText, contextHeading) : 0;
    const contextMatch = contextFull ? scoreFieldText(rawTargetText, contextFull) : 0;
    const bestContextMatch = Math.max(headingMatch, contextMatch);

    const isGenericMoreInfo = GENERIC_MORE_INFO_RE.test(label.trim());
    let eScore = 0;
    if (action === 'MORE_INFO') {
      if (isGenericMoreInfo && bestContextMatch >= 0.48) {
        eScore = Math.min(0.94, 0.72 + bestContextMatch * 0.22);
      } else if (labelScore >= 0.3 || hrefScore >= 0.5) {
        const combined = Math.max(labelScore, hrefScore);
        eScore = Math.min(0.96, combined + (bestContextMatch >= 0.48 ? 0.06 : 0) + (hrefScore >= 0.5 && labelScore >= 0.3 ? 0.08 : 0));
      } else if (bestContextMatch >= 0.65) {
        eScore = Math.min(0.76, bestContextMatch * 0.78);
      }
    } else if (bestContextMatch >= 0.65 && Math.max(labelScore, ariaScore, titleScore, hrefScore) < 0.45) {
      eScore = Math.min(0.56, bestContextMatch * 0.58);
    }

    let baseScore = Math.max(labelScore, ariaScore, titleScore, hrefScore, eScore);
    if (baseScore <= 0) {
      return { score: 0, baseScore: 0, genericMoreInfo: isGenericMoreInfo };
    }

    // (e2) Explicit section / list / table scope constraint ("select Bank card under Cards")
    const leafSectionPath = Array.isArray(targetObj.sectionPath) && targetObj.sectionPath.length > 1
      ? targetObj.sectionPath.slice(1).join(' ')
      : sectionPathText;
    const sectionContextPool = [contextHeading, leafSectionPath, listContext, tableText].filter(Boolean).join(' ');
    if (sectionFilter) {
      if (sectionContextPool) {
        const cleanSf = sectionFilter.toLowerCase().trim();
        const leafExactRe = new RegExp(`(?:^|\\b)${cleanSf.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:\\b|$)`, 'i');
        const directLeafHit = leafExactRe.test(contextHeading) || leafExactRe.test(leafSectionPath) || leafExactRe.test(listContext);
        const secMatch = directLeafHit
          ? 1.0
          : scoreFieldText(sectionFilter, sectionContextPool, { stripQueryNoise: false });
        if (secMatch >= 0.55) {
          baseScore = Math.min(1.0, baseScore + 0.14);
        } else if (secMatch < 0.25) {
          baseScore = Math.min(0.36, baseScore * 0.42);
        } else {
          // Mild ambiguity penalty when root heading partially matched but leaf section did not
          baseScore = Math.min(0.55, baseScore * 0.58);
        }
      } else {
        baseScore = baseScore * 0.65;
      }
    }

    // (f) Small contextual boosts (viewport, main content, matching spoken area/role/position, official source preference)
    let boost = 0;
    const flags = targetObj.flags || {};
    const category = String(targetObj.category || flags.category || '').toLowerCase();
    const isOfficialSource = Boolean(flags.official || category === 'official' || category === 'documentation');
    if (baseScore >= 0.35) {
      if (flags.inViewport) boost += 0.018;
      if (flags.inMain || targetObj.area === 'main' || targetObj.area === 'card') boost += 0.018;
      if (spec.area && targetObj.area && spec.area === targetObj.area) boost += 0.045;
      if (spec.roleHint && targetObj.role && spec.roleHint === targetObj.role) boost += 0.025;
      if (spec.positionHint === 'top_right' && targetObj.position && targetObj.position.isTopRight) boost += 0.06;
      if (linkPreference === 'official' || linkPreference === 'documentation') {
        if (isOfficialSource) boost += 0.11;
        else if (category === 'tutorial' || /\b(?:unofficial|blog|reddit|medium|forum)\b/i.test(`${label} ${targetObj.domain || ''}`)) boost -= 0.10;
      } else if (linkPreference === 'tutorial' && category === 'tutorial') {
        boost += 0.08;
      }
    }

    const finalScore = Math.max(0, Math.min(1.0, Math.round((baseScore + boost) * 1000) / 1000));
    return {
      score: finalScore,
      baseScore: Math.round(baseScore * 1000) / 1000,
      genericMoreInfo: isGenericMoreInfo
    };
  }

  function _scoreAreaAndPositionOnly(targetObj, spec) {
    if (spec.area && targetObj.area !== spec.area) return 0;
    if (spec.roleHint && targetObj.role !== spec.roleHint) return 0;
    if (spec.positionHint === 'top_right') {
      return (targetObj.position && targetObj.position.isTopRight) ? 0.92 : 0.1;
    }
    return 0.75;
  }

  /**
   * Filter, rank, and pick/disambiguate targets cleanly without calling any LLM.
   */
  function decideMatch(targets, querySpec = {}) {
    const spec = typeof querySpec === 'string' ? { target: querySpec } : (querySpec || {});
    const list = Array.isArray(targets) ? targets : [];
    if (list.length === 0) {
      return { outcome: 'no_match', best: null, options: [], nearest: [] };
    }

    // Pure positional selection without a label target ("first link in menu", "last button", "top right link")
    if (!String(spec.target || '').trim() && (spec.ordinal || spec.positionHint || spec.area)) {
      let pool = list.slice();
      if (spec.area) {
        const inArea = pool.filter((t) => t.area === spec.area);
        if (inArea.length > 0) pool = inArea;
      }
      if (spec.roleHint) {
        const inRole = pool.filter((t) => t.role === spec.roleHint);
        if (inRole.length > 0) pool = inRole;
      }
      if (spec.positionHint === 'top_right') {
        const tr = pool.filter((t) => t.position && t.position.isTopRight);
        if (tr.length > 0) pool = tr;
        else {
          pool.sort((a, b) => {
            const ra = (a.position && a.position.rect) || { top: 9999, left: 0 };
            const rb = (b.position && b.position.rect) || { top: 9999, left: 0 };
            return (rb.left - ra.left) - (rb.top - ra.top);
          });
        }
      }
      let picked = null;
      if (spec.positionHint === 'last') picked = pool[pool.length - 1] || null;
      else if (Number.isInteger(spec.ordinal) && spec.ordinal >= 1) picked = pool[spec.ordinal - 1] || null;
      else picked = pool[0] || null;

      if (picked) {
        return {
          outcome: 'act',
          best: { target: picked, score: 0.92, baseScore: 0.90 },
          options: [{ target: picked, score: 0.92 }],
          nearest: pool.slice(0, 3).map((t) => ({ target: t, score: 0.7 }))
        };
      }
      return { outcome: 'no_match', best: null, options: [], nearest: list.slice(0, 3).map((t) => ({ target: t, score: 0 })) };
    }

    const scored = list.map((t) => {
      const res = scoreTarget(t, spec);
      return { target: t, ...res };
    });

    scored.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      const aOrd = (a.target.position && a.target.position.index) ?? 0;
      const bOrd = (b.target.position && b.target.position.index) ?? 0;
      return aOrd - bOrd;
    });

    const top = scored[0];
    const runnerUp = scored[1] || null;
    const nearest = scored.slice(0, 3);

    if (!top || top.score < 0.4) {
      return { outcome: 'no_match', best: null, options: [], nearest };
    }

    // Never guess when two candidates are equally good (base content scores essentially tied).
    const baseLead = runnerUp ? (top.baseScore - runnerUp.baseScore) : 1;
    const scoreLead = runnerUp ? (top.score - runnerUp.score) : 1;
    const nearlyEqual = Boolean(runnerUp && (baseLead < 0.03 || scoreLead < 0.05) && runnerUp.score >= 0.4);

    if (!nearlyEqual && top.score >= 0.85 && scoreLead >= 0.15) {
      return { outcome: 'act', best: top, options: [top], nearest };
    }

    const closeOptions = scored
      .filter((s) => s.score >= Math.max(0.4, top.score - 0.25))
      .slice(0, 5);

    return {
      outcome: 'disambiguate',
      best: top,
      options: closeOptions.length > 0 ? closeOptions : [top],
      nearest
    };
  }

  /**
   * Backward-compatible 0..100 score helper used by navigate.js / intent.js / existing tests.
   */
  function scoreCandidate(query, label) {
    const res = scoreTarget({ label }, { target: query, action: 'CLICK' });
    return Math.round(res.score * 100);
  }

  function parseOrdinalChoice(text, max = 5) {
    const cap = Number.isFinite(Number(max)) && Number(max) >= 1 ? Math.floor(Number(max)) : 5;
    if (typeof text === 'number') {
      return Number.isInteger(text) && text >= 1 && text <= cap ? text : null;
    }
    const raw = String(text || '').trim();
    if (!raw) return null;

    let clean = raw.normalize('NFC').toLowerCase();
    clean = clean.replace(/[०-९]/g, (d) => DEVANAGARI_DIGITS[d] || d);
    clean = clean.replace(/[.,!?।,;:'"()\[\]]+/g, ' ').replace(/\s+/g, ' ').trim();
    if (!clean) return null;

    if (/^(?:do\s+it|do\s+this|do\s+that)$/i.test(clean)) return null;
    if (/(?:kar|कर|khol|खोल|daba|दबा|bata|बता|padh|पढ़|sun|सुन|likh|लिख|bhej|भेज|chala|चला|band|बंद)\s+(?:do|दो)$/i.test(clean)) {
      return null;
    }

    if (Object.prototype.hasOwnProperty.call(ORDINAL_MAP, clean)) {
      const val = ORDINAL_MAP[clean];
      return val <= cap ? val : null;
    }

    const tokens = clean.split(' ').filter(Boolean);
    if (tokens.length === 0 || tokens.length > 3) return null;

    const LEADING_WRAPPERS = new Set([
      'option', 'choice', 'item', 'number', 'no', 'num',
      'select', 'pick', 'choose', 'open', 'click', 'press', 'tap',
      'ऑप्शन', 'विकल्प', 'नंबर', 'क्रमांक', 'नम्बर'
    ]);
    const TRAILING_WRAPPERS = new Set([
      'number', 'no', 'num', 'wala', 'wali', 'wale',
      'link', 'button', 'btn', 'option', 'choice',
      'खोलो', 'दबाओ', 'चुनो', 'करो',
      'kholo', 'dabao', 'chuno', 'karo',
      'नंबर', 'नम्बर', 'वाला', 'वाली', 'वाले', 'लिंक', 'बटन'
    ]);

    let start = 0;
    let end = tokens.length - 1;
    while (start < end && LEADING_WRAPPERS.has(tokens[start])) start += 1;
    while (end > start && TRAILING_WRAPPERS.has(tokens[end])) end -= 1;

    if (start !== end) return null;
    const core = tokens[start];
    if (!Object.prototype.hasOwnProperty.call(ORDINAL_MAP, core)) return null;

    if ((core === 'do' || core === 'दो') && start > 0 && ['open', 'click', 'press', 'tap'].includes(tokens[start - 1])) {
      return null;
    }

    const val = ORDINAL_MAP[core];
    return val <= cap ? val : null;
  }

  // =========================================================================
  // Page-Grounded Fuzzy Matching & Chrome N-Best Backup Guess Re-Ranker
  // =========================================================================
  const SENSITIVE_ACTION_LABEL_RE = /\b(?:sign\s*out|log\s*out|delete|remove|erase|unsubscribe|deactivate|close\s+account|pay\b|payment|purchase|buy\s+now|place\s+order|checkout|check\s+out|submit|transfer|wire|send\s+money|reset\s+all)\b/i;

  function isSensitiveActionLabel(label) {
    return SENSITIVE_ACTION_LABEL_RE.test(String(label || ''));
  }

  function normalizeCompoundHomophones(rawText) {
    let s = String(rawText || '')
      .normalize('NFC')
      .toLowerCase()
      .replace(/['’`]/g, '')
      .replace(/[-_/]+/g, ' ')
      .replace(/[.,!?;:()\[\]{}"“”]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (!s) return '';

    return s
      .replace(/\byou\s+tube\b/g, 'youtube')
      .replace(/\byoutube\s+stud(?:y(?:\s+oh)?|i|eo|ios)\b/g, 'youtube studio')
      .replace(/\bcreator\s+stud(?:y(?:\s+oh)?|i|eo|ios)\b/g, 'creator studio')
      .replace(/\bsine\s+in\b|\bsignin\b/g, 'sign in')
      .replace(/\bsine\s+up\b|\bsignup\b/g, 'sign up')
      .replace(/\blogin\b/g, 'log in')
      .replace(/\blogout\b/g, 'log out')
      .replace(/\bsignout\b/g, 'sign out')
      .replace(/\bsub\s+scriptions?\b|\bsub\s+descriptions?\b|\bsubscrib\s*tions?\b/g, 'subscriptions')
      .replace(/\bset\s+tings?\b/g, 'settings')
      .replace(/\bplay\s+lists?\b/g, 'playlists')
      .replace(/\bwatch\s*later\b/g, 'watch later')
      .replace(/\bdark\s+(?:theam|team|mod)\b/g, 'dark theme')
      .replace(/\blight\s+(?:theam|team|mod)\b/g, 'light theme')
      .replace(/\bfull\s+screen\b/g, 'fullscreen')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function jaroWinklerSimilarity(a, b) {
    const s1 = String(a || '');
    const s2 = String(b || '');
    if (s1 === s2) return s1.length > 0 ? 1.0 : 0;
    const len1 = s1.length;
    const len2 = s2.length;
    if (len1 === 0 || len2 === 0) return 0;

    const matchDist = Math.max(0, Math.floor(Math.max(len1, len2) / 2) - 1);
    const s1Matches = new Array(len1).fill(false);
    const s2Matches = new Array(len2).fill(false);

    let matches = 0;
    for (let i = 0; i < len1; i++) {
      const start = Math.max(0, i - matchDist);
      const end = Math.min(i + matchDist + 1, len2);
      for (let j = start; j < end; j++) {
        if (s2Matches[j] || s1[i] !== s2[j]) continue;
        s1Matches[i] = true;
        s2Matches[j] = true;
        matches += 1;
        break;
      }
    }
    if (matches === 0) return 0;

    let transpositions = 0;
    let k = 0;
    for (let i = 0; i < len1; i++) {
      if (!s1Matches[i]) continue;
      while (!s2Matches[k]) k += 1;
      if (s1[i] !== s2[k]) transpositions += 1;
      k += 1;
    }

    const jaro = ((matches / len1) + (matches / len2) + ((matches - transpositions / 2) / matches)) / 3;
    let prefix = 0;
    const maxPrefix = Math.min(4, len1, len2);
    while (prefix < maxPrefix && s1[prefix] === s2[prefix]) prefix += 1;
    return Math.min(1.0, jaro + prefix * 0.1 * (1 - jaro));
  }

  /**
   * Bounded fuzzy + phonetic + compound similarity score (0..1) between a target query
   * and a visible UI label. Refuses short-word (<3 char) false positives and caps
   * destructive/sensitive labels unless virtually exact.
   */
  function fuzzyLabelScore(query, candidateLabel, options = {}) {
    const qNorm = normalizeCompoundHomophones(query);
    const cNorm = normalizeCompoundHomophones(candidateLabel);
    if (!qNorm || !cNorm) return 0;

    if (qNorm === cNorm) return 1.0;

    // Short queries ("ok", "no", "up", "go") must match exactly — never fuzzy-match short words!
    if (qNorm.length <= 2 || cNorm.length <= 2) {
      return 0;
    }

    let best = scoreFieldText(qNorm, cNorm, options);

    // Collapsed compound comparison ("sub scription" <-> "subscriptions", "sign in" <-> "signin")
    const qCollapsed = qNorm.replace(/\s+/g, '');
    const cCollapsed = cNorm.replace(/\s+/g, '');
    if (qCollapsed.length >= 4 && cCollapsed.length >= 4) {
      if (qCollapsed === cCollapsed) {
        best = Math.max(best, 0.97);
      } else {
        const cDist = editDistance(qCollapsed, cCollapsed);
        const maxLen = Math.max(qCollapsed.length, cCollapsed.length);
        const editSim = 1 - (cDist / maxLen);
        const jw = jaroWinklerSimilarity(qCollapsed, cCollapsed);
        if (cDist <= 1 && maxLen >= 5) {
          best = Math.max(best, 0.93);
        } else if (cDist <= 2 && maxLen >= 8 && editSim >= 0.78) {
          best = Math.max(best, 0.88);
        } else if (jw >= 0.90 && editSim >= 0.74) {
          best = Math.max(best, Math.min(0.91, 0.78 + (jw - 0.88) * 1.1));
        }
      }
    }

    // Token-aligned fuzzy matching for multi-word UI labels ("acount setings" -> "Account settings")
    const qWords = qNorm.split(' ').filter((w) => w.length > 0 && !LABEL_STRIP_WORDS.has(w));
    const cWords = cNorm.split(' ').filter((w) => w.length > 0 && !LABEL_STRIP_WORDS.has(w));
    if (qWords.length > 0 && cWords.length > 0) {
      let matchedSum = 0;
      for (const qw of qWords) {
        let bestTok = 0;
        for (const cw of cWords) {
          if (qw === cw || stemToken(qw) === stemToken(cw)) {
            bestTok = 1.0;
            break;
          }
          const minW = Math.min(qw.length, cw.length);
          const maxW = Math.max(qw.length, cw.length);
          if (minW >= 4) {
            const d = editDistance(qw, cw);
            if (d <= 1) bestTok = Math.max(bestTok, 0.92);
            else if (d <= 2 && maxW >= 7) bestTok = Math.max(bestTok, 0.85);
            else {
              const tokJw = jaroWinklerSimilarity(qw, cw);
              if (tokJw >= 0.89 && (1 - d / maxW) >= 0.70) bestTok = Math.max(bestTok, 0.84);
            }
          }
        }
        matchedSum += bestTok;
      }
      const qCov = matchedSum / qWords.length;
      const cCov = Math.min(1, matchedSum / cWords.length);
      if (qCov >= 0.84 && cCov >= 0.80) {
        best = Math.max(best, Math.min(0.94, 0.76 * qCov + 0.18 * cCov));
      } else if (qCov >= 0.88 && cWords.length <= qWords.length + 1) {
        best = Math.max(best, 0.84);
      }
    }

    // Safety cap: never allow loose fuzzy matching onto destructive/payment/sign-out controls
    if (!options.allowSensitiveFuzzy && isSensitiveActionLabel(cNorm) && best < 0.96) {
      return Math.min(best, 0.55);
    }

    return Math.min(1.0, best);
  }

  function repairLeadingCommandVerb(rawText) {
    const trimmed = String(rawText || '').trim();
    if (!trimmed) return { text: '', verbRepaired: false };

    const rules = [
      [/^(?:clik|clck|clic|klick|clcik)\s+(.+)$/i, 'click $1'],
      [/^(?:opin|opne|opn|openn)\s+(.+)$/i, 'open $1'],
      [/^(?:selct|slect|selec|slecte)\s+(.+)$/i, 'select $1'],
      [/^(?:scrol|scorll|scrool)\s+(up\b|down\b|top\b|bottom\b|to\s+.+)$/i, 'scroll $1'],
      [/^(?:serch|saerch|seach|reserch)\s+(.+)$/i, 'search $1'],
      [/^(?:sumarize|summerize|summrize)\s*(.*)$/i, (_m, rest) => (rest ? `summarize ${rest}` : 'summarize this page')]
    ];

    for (const [re, repl] of rules) {
      if (re.test(trimmed)) {
        const next = typeof repl === 'function' ? trimmed.replace(re, repl) : trimmed.replace(re, repl);
        return { text: next.trim(), verbRepaired: true };
      }
    }
    return { text: trimmed, verbRepaired: false };
  }

  const FREEFORM_PAYLOAD_CMD_RE = /^(?:search|google|look\s+up|find\s+videos?|type|write|enter|dictate|paste|remind\s+me|teach|calculate|compute)\b/i;
  const BUILTIN_NAV_GRAMMAR_RE = /^(?:scroll\s+(?:down|up|to\s+(?:the\s+)?(?:top|bottom))|go\s+(?:back|forward)|read\s+(?:this\s+page|the\s+page|page|aloud|it\s+again|again)|(?:stop|pause|resume)(?:\s+reading)?|(?:summarize|summarise|explain)(?:\s+(?:this|the)\s+(?:page|webpage|article))?|outline|show\s+outline|list\s+tabs|you\s+can\s+rest|cancel|stop)$/i;
  const DESKTOP_GUARD_RE = /\b(?:notepad|calculator|calc\.exe|windows\s+settings|file\s+explorer|desktop\s+(?:app|window|document)|local\s+(?:file|document))\b/i;

  function findBestPageCandidateMatch(targetQuery, candidates, allowedKinds = null) {
    const cleanQ = String(targetQuery || '').replace(/^(?:on|the|a|an)\s+/i, '').replace(/\s+(?:button|link|option|menu|item|tab|field|input)$/i, '').trim();
    if (!cleanQ || cleanQ.length < 3) {
      return { best: null, bestScore: 0, secondScore: 0, lead: 0 };
    }
    const byNormLabel = new Map();
    for (const c of (candidates || [])) {
      if (!c || !c.label) continue;
      if (allowedKinds && !allowedKinds.has(c.kind || 'control')) continue;
      const lbl = String(c.label).replace(/\s+/g, ' ').trim();
      if (!lbl || lbl.length > 90) continue;
      const key = lbl.toLowerCase();
      let s = fuzzyLabelScore(cleanQ, lbl);
      if (s > 0 && c.kind === 'open_menu') {
        s = Math.min(1.0, s + 0.04);
      }
      const prev = byNormLabel.get(key);
      if (!prev || s > prev.score) {
        byNormLabel.set(key, {
          label: lbl,
          kind: c.kind || 'control',
          isSensitive: Boolean(c.isSensitive || isSensitiveActionLabel(lbl)),
          score: s,
          rawScore: fuzzyLabelScore(cleanQ, lbl, { allowSensitiveFuzzy: true })
        });
      }
    }
    const ranked = Array.from(byNormLabel.values()).sort((a, b) => b.score - a.score);
    const top = ranked[0] || null;
    const second = ranked[1] || null;
    return {
      best: top,
      bestScore: top ? top.score : 0,
      secondScore: second ? second.score : 0,
      lead: top ? (top.score - (second ? second.score : 0)) : 0
    };
  }

  function evaluateCommandHypothesis(rawHypothesis, rank, candidates, inputSource = 'voice') {
    const repaired = repairLeadingCommandVerb(rawHypothesis);
    let working = repaired.text;
    const rankPenalty = Math.max(0, Number(rank) || 0) * 0.03;

    if (!working) {
      return { text: '', netScore: 0, rawMatchScore: 0, matchedLabel: null, isSensitive: false, reason: 'empty', rank };
    }

    // Never mutate free-form search/dictation/desktop payloads
    if (FREEFORM_PAYLOAD_CMD_RE.test(working) || DESKTOP_GUARD_RE.test(working)) {
      return {
        text: working,
        netScore: Math.max(0, (repaired.verbRepaired ? 0.78 : 0.72) - rankPenalty),
        rawMatchScore: repaired.verbRepaired ? 0.78 : 0.72,
        matchedLabel: null,
        isSensitive: false,
        reason: repaired.verbRepaired ? 'verb_typo_repair' : 'passthrough_freeform',
        rank,
        changedFromRaw: working !== String(rawHypothesis || '').trim()
      };
    }

    // Built-in navigation / reading / control commands
    if (BUILTIN_NAV_GRAMMAR_RE.test(working)) {
      return {
        text: working,
        netScore: Math.max(0, 0.93 - rankPenalty),
        rawMatchScore: 0.93,
        matchedLabel: null,
        isSensitive: false,
        reason: 'builtin_command_grammar',
        rank,
        changedFromRaw: working !== String(rawHypothesis || '').trim()
      };
    }

    // Form field fill ("fill <field> with <value>") -> ONLY match <field>, NEVER touch <value>!
    const fillMatch = working.match(/^(fill(?:\s+in|\s+out)?)\s+(?:the\s+)?(.+?)\s+(with|as|to)\s+(.+)$/i);
    if (fillMatch) {
      const verbPart = fillMatch[1];
      const fieldQuery = fillMatch[2].trim();
      const prepPart = fillMatch[3];
      const valuePart = fillMatch[4]; // strictly untouched!
      const m = findBestPageCandidateMatch(fieldQuery, candidates, new Set(['input']));
      if (m.best && m.bestScore >= 0.85 && m.lead >= 0.12 && !m.best.isSensitive) {
        const snapped = `${verbPart} ${m.best.label} ${prepPart} ${valuePart}`;
        return {
          text: snapped,
          netScore: Math.max(0, m.bestScore - rankPenalty),
          rawMatchScore: m.bestScore,
          matchedLabel: m.best.label,
          isSensitive: false,
          reason: 'form_field_fuzzy_match',
          rank,
          changedFromRaw: snapped.toLowerCase() !== String(rawHypothesis || '').trim().toLowerCase()
        };
      }
      return {
        text: working,
        netScore: Math.max(0, 0.68 - rankPenalty),
        rawMatchScore: m.bestScore || 0.68,
        matchedLabel: null,
        isSensitive: false,
        reason: 'fill_passthrough',
        rank,
        changedFromRaw: working !== String(rawHypothesis || '').trim()
      };
    }

    // Hierarchical command ("open <Menu> and select <Option>" / "under <Menu> select <Option>")
    const hierAndMatch = working.match(/^((?:open|expand|click)\s+(?:the\s+)?)(.+?)(\s+(?:and|then)\s+(?:select|choose|pick|click|open)\s+(?:the\s+)?)(.+)$/i);
    if (hierAndMatch) {
      const menuQ = hierAndMatch[2].trim();
      const optQ = normalizeCompoundHomophones(hierAndMatch[4].trim());
      const mMenu = findBestPageCandidateMatch(menuQ, candidates);
      const mOpt = findBestPageCandidateMatch(optQ, candidates);
      const bestMenuLbl = (mMenu.best && mMenu.bestScore >= 0.86 && mMenu.lead >= 0.12 && !mMenu.best.isSensitive) ? mMenu.best.label : hierAndMatch[2].trim();
      const bestOptLbl = (mOpt.best && mOpt.bestScore >= 0.86 && mOpt.lead >= 0.12 && !mOpt.best.isSensitive)
        ? mOpt.best.label
        : (optQ !== hierAndMatch[4].trim().toLowerCase() ? optQ : hierAndMatch[4].trim());
      const rebuilt = `${hierAndMatch[1]}${bestMenuLbl}${hierAndMatch[3]}${bestOptLbl}`.replace(/\s+/g, ' ').trim();
      const combinedScore = Math.max(mOpt.bestScore, mMenu.bestScore * 0.9, optQ !== hierAndMatch[4].trim().toLowerCase() ? 0.86 : 0.72);
      return {
        text: rebuilt,
        netScore: Math.max(0, combinedScore - rankPenalty),
        rawMatchScore: combinedScore,
        matchedLabel: (mOpt.best && mOpt.best.label) || bestOptLbl,
        isSensitive: Boolean((mOpt.best && mOpt.best.isSensitive) || isSensitiveActionLabel(bestOptLbl)),
        reason: 'hierarchical_target_match',
        rank,
        changedFromRaw: rebuilt.toLowerCase() !== String(rawHypothesis || '').trim().toLowerCase()
      };
    }

    // Acoustic verb confusions in voice mode ("clip subscriptions" -> "click Subscriptions", "hop in settings" -> "open Settings")
    // Strictly gated: ONLY if the target strongly matches a real visible element on screen (>= 0.90)!
    if (inputSource === 'voice') {
      const acousticMatch = working.match(/^(clip|lip|hop\s+in)\s+(?:on\s+)?(?:the\s+)?(.+)$/i);
      if (acousticMatch) {
        const mappedVerb = /^hop/i.test(acousticMatch[1]) ? 'open' : 'click';
        const targetRaw = acousticMatch[2].trim();
        const m = findBestPageCandidateMatch(targetRaw, candidates);
        if (m.best && m.bestScore >= 0.90 && m.lead >= 0.14 && !m.best.isSensitive) {
          const snapped = `${mappedVerb} ${m.best.label}`;
          return {
            text: snapped,
            netScore: Math.max(0, m.bestScore - rankPenalty),
            rawMatchScore: m.bestScore,
            matchedLabel: m.best.label,
            isSensitive: false,
            reason: 'acoustic_verb_and_dom_match',
            rank,
            changedFromRaw: true
          };
        }
      }
    }

    // Standard single-target browser action ("click/open/select/choose/expand/scroll to <Target>")
    const actionMatch = working.match(/^(click|tap|press|open|select|choose|pick|expand|collapse|toggle|hover(?:\s+over)?|scroll\s+to)\s+(?:on\s+)?(?:the\s+)?(.+)$/i);
    if (actionMatch) {
      const verb = actionMatch[1];
      const rawRest = actionMatch[2].trim();
      // Skip URLs or multi-clause commands
      if (/^(?:https?:\/\/|www\.)/i.test(rawRest) || /\b(?:and\s+then|and\s+(?:click|select|open|type|fill|write)|under\s+|inside\s+|from\s+)\b/i.test(rawRest)) {
        const homophoneFixed = `${verb} ${normalizeCompoundHomophones(rawRest) || rawRest}`;
        return {
          text: /\byoutube\s+studio|creator\s+studio|dark\s+theme|light\s+theme|subscriptions\b/i.test(homophoneFixed) ? homophoneFixed : working,
          netScore: Math.max(0, 0.74 - rankPenalty),
          rawMatchScore: 0.74,
          matchedLabel: null,
          isSensitive: isSensitiveActionLabel(rawRest),
          reason: 'complex_action_passthrough',
          rank,
          changedFromRaw: false
        };
      }

      const m = findBestPageCandidateMatch(rawRest, candidates);
      if (m.best && m.bestScore >= 0.85 && m.lead >= 0.12 && !m.best.isSensitive) {
        const snapped = `${verb} ${m.best.label}`;
        return {
          text: snapped,
          netScore: Math.max(0, m.bestScore - rankPenalty),
          rawMatchScore: m.bestScore,
          matchedLabel: m.best.label,
          isSensitive: false,
          reason: 'dom_target_fuzzy_snap',
          rank,
          changedFromRaw: snapped.toLowerCase() !== String(rawHypothesis || '').trim().toLowerCase()
        };
      }

      // Even if target is inside a closed submenu (not yet visible in DOM!), fix known compound homophones like "open youtube study oh" -> "open youtube studio"
      const normTarget = normalizeCompoundHomophones(rawRest);
      if (normTarget && normTarget !== rawRest.toLowerCase() && /\b(?:youtube studio|creator studio|subscriptions|dark theme|light theme|watch later|sign in)\b/.test(normTarget)) {
        const homophoneCmd = `${verb} ${normTarget}`;
        return {
          text: homophoneCmd,
          netScore: Math.max(0, 0.86 - rankPenalty),
          rawMatchScore: 0.86,
          matchedLabel: normTarget,
          isSensitive: isSensitiveActionLabel(normTarget),
          reason: 'compound_homophone_repair',
          rank,
          changedFromRaw: true
        };
      }

      return {
        text: working,
        netScore: Math.max(0, Math.max(0.65, m.bestScore) - rankPenalty),
        rawMatchScore: m.bestScore || 0.65,
        matchedLabel: m.best ? m.best.label : null,
        isSensitive: Boolean(m.best && m.best.isSensitive),
        reason: repaired.verbRepaired ? 'verb_typo_repair' : 'action_unmatched',
        rank,
        changedFromRaw: working !== String(rawHypothesis || '').trim()
      };
    }

    // Bare phrase when an open popup/menu is active on screen (e.g. user says just "YouTube Studio" while Account menu is open)
    const wordCount = working.split(/\s+/).filter(Boolean).length;
    if (wordCount >= 1 && wordCount <= 5) {
      const openMenuMatch = findBestPageCandidateMatch(working, candidates, new Set(['open_menu']));
      if (openMenuMatch.best && openMenuMatch.bestScore >= 0.88 && openMenuMatch.lead >= 0.12 && !openMenuMatch.best.isSensitive) {
        const snapped = `select ${openMenuMatch.best.label}`;
        return {
          text: snapped,
          netScore: Math.max(0, openMenuMatch.bestScore - rankPenalty),
          rawMatchScore: openMenuMatch.bestScore,
          matchedLabel: openMenuMatch.best.label,
          isSensitive: false,
          reason: 'open_menu_bare_option_match',
          rank,
          changedFromRaw: true
        };
      }
    }

    return {
      text: working,
      netScore: Math.max(0, 0.60 - rankPenalty),
      rawMatchScore: 0.60,
      matchedLabel: null,
      isSensitive: isSensitiveActionLabel(working),
      reason: repaired.verbRepaired ? 'verb_typo_repair' : 'unchanged',
      rank,
      changedFromRaw: working !== String(rawHypothesis || '').trim()
    };
  }

  /**
   * Re-ranks Chrome's primary transcript + N-best backup guesses (rank 0..3) against
   * live page elements and built-in command grammar, snapping clear typos/homophones
   * to exact page labels while strictly protecting search/dictation/sensitive controls.
   */
  function resolveFuzzyCommandAndAlternatives(options = {}) {
    const primaryRaw = String(options.primaryText || '').trim();
    const inputSource = options.inputSource || 'voice';
    const candidates = Array.isArray(options.candidates) ? options.candidates : [];
    const rawAlts = Array.isArray(options.alternatives) ? options.alternatives : [];

    if (!primaryRaw) {
      return { text: '', changed: false, usedAlternativeRank: 0, matchedTargetLabel: null, reason: 'empty', alternatives: [] };
    }

    const hypotheses = [{ transcript: primaryRaw, confidence: null, rank: 0 }];
    const seen = new Set([primaryRaw.toLowerCase().replace(/\s+/g, ' ')]);
    for (let i = 0; i < rawAlts.length && hypotheses.length < 4; i++) {
      const item = rawAlts[i];
      const tr = String((typeof item === 'string' ? item : (item && item.transcript)) || '').trim();
      const key = tr.toLowerCase().replace(/\s+/g, ' ');
      if (tr && !seen.has(key)) {
        seen.add(key);
        hypotheses.push({
          transcript: tr,
          confidence: item && typeof item.confidence === 'number' ? item.confidence : null,
          rank: typeof (item && item.rank) === 'number' ? Math.max(1, item.rank) : hypotheses.length
        });
      }
    }

    const evaluated = hypotheses.map((h) => evaluateCommandHypothesis(h.transcript, h.rank, candidates, inputSource));
    const primaryEval = evaluated[0];
    let chosen = primaryEval;

    // Only upgrade to a Chrome backup guess (rank >= 1) if it is strongly grounded (>= 0.84)
    // AND beats Guess #1 by a clear margin (>= 0.11), and never loosely triggers sensitive actions!
    for (let i = 1; i < evaluated.length; i++) {
      const cand = evaluated[i];
      if (cand.isSensitive && cand.rawMatchScore < 0.96) continue;
      if (cand.netScore >= 0.84 && (cand.netScore - primaryEval.netScore) >= 0.11 && cand.netScore > chosen.netScore) {
        chosen = cand;
      }
    }

    return {
      text: chosen.text || primaryRaw,
      originalText: primaryRaw,
      changed: (chosen.text || primaryRaw).toLowerCase() !== primaryRaw.toLowerCase(),
      usedAlternativeRank: chosen.rank || 0,
      matchedTargetLabel: chosen.matchedLabel || null,
      reason: chosen.rank > 0 ? `chrome_backup_guess_${chosen.rank}_${chosen.reason}` : chosen.reason,
      score: chosen.netScore,
      alternatives: hypotheses.map((h) => h.transcript)
    };
  }

  const api = {
    phoneticSkeleton,
    phoneticKey,
    phoneticTokens,
    normalizeSpelledLetters,
    normalizeCompoundHomophones,
    jaroWinklerSimilarity,
    isSensitiveActionLabel,
    fuzzyLabelScore,
    resolveFuzzyCommandAndAlternatives,
    stemToken,
    editDistance,
    scoreFieldText,
    splitScopedLinkTarget,
    scoreTarget,
    decideMatch,
    scoreCandidate,
    parseOrdinalChoice,
    stripCommandNoise
  };

  if (root) {
    root.SleepwalkerMatch = api;
  }
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
})(typeof window !== 'undefined' ? window : globalThis);
