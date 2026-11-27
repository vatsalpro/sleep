'use strict';

/**
 * 320+ voice command test corpus covering:
 * - English typos
 * - Romanized Hindi
 * - Devanagari Hindi
 * - Hinglish (code-switched)
 * - Kannada (script + romanized)
 * - Core English commands & edge cases
 *
 * Each entry: { cat, input, expectedTypes: string[] }
 */
function buildVoiceCorpus() {
  const rows = [];
  const add = (cat, expectedTypes, list) => {
    for (const input of list) rows.push({ cat, input, expectedTypes });
  };

  // 1. TYPOS (~60)
  add('typos', ['READ_PAGE'], [
    'red this page', 'read tis page', 'reed this page', 'raed page', 'read al',
    'strat reading', 'read contnt', 'read ths pge', 'red page', 'readthis page'
  ]);
  add('typos', ['OUTLINE'], [
    'outlin', 'show outlne', 'hedings', 'show hedings', 'table of contnts',
    'sectons', 'outlien', 'headngs', 'show sectons', 'out line'
  ]);
  add('typos', ['EXPLAIN'], [
    'explan this page', 'explian page', 'sumarize this page', 'summerize page',
    'wat is this page about', 'explan', 'sumarise', 'expln this page', 'sumrize', 'explain tis page'
  ]);
  add('typos', ['PAUSE', 'STOP'], [
    'paus', 'puase', 'hold o', 'wat', 'stpo', 'cancle', 'shut u', 'be qiet', 'pauss', 'stpp'
  ]);
  add('typos', ['RESUME', 'READ_AGAIN'], [
    'resum', 'contnue', 'kep reading', 'ply', 'read agin', 'repat', 'strat over',
    'read it agan', 'resuem', 'continye'
  ]);
  add('typos', ['NAVIGATE_SECTION', 'QUERY_OR_SEARCH'], [
    'opin settings', 'clik login', 'go to contct', 'scrol to footer', 'shw me pricing',
    'tak me to faq', 'jump to overvew', 'opn account', 'selct dark theme', 'navgate to help'
  ]);

  // 2. ROMANIZED HINDI (~55)
  add('romanized_hindi', ['READ_PAGE'], [
    'yeh page padho', 'ye page padho', 'page padho', 'pura padho', 'padho',
    'sunao', 'is page ko padho', 'shuru se padho', 'padhna shuru karo', 'page sunao'
  ]);
  add('romanized_hindi', ['EXPLAIN', 'EXPLAIN_SECTION'], [
    'yeh page samjhao', 'page samjhao', 'is page ko samjhao', 'samjhao',
    'yeh page kis baare mein hai', 'page ka saransh', 'fees samjhao', 'eligibility samjhao',
    'admission ke baare mein batao', 'pricing samjhao'
  ]);
  add('romanized_hindi', ['OUTLINE'], [
    'outline dikhao', 'headings dikhao', 'vishay suchi', 'ruprekha', 'shirshak dikhao',
    'sections dikhao', 'sab headings batao'
  ]);
  add('romanized_hindi', ['STOP', 'PAUSE', 'RESUME', 'READ_AGAIN'], [
    'band karo', 'ruko', 'roko', 'chup raho', 'shant', 'khatam karo',
    'aage padho', 'jari rakho', 'phir se padho', 'dobara padho', 'shuru se sunao', 'thehro'
  ]);
  add('romanized_hindi', ['HELP'], [
    'madad', 'madad karo', 'sahayata', 'kya kar sakte ho', 'help karo'
  ]);
  add('romanized_hindi', ['NAVIGATE_SECTION', 'QUERY_OR_SEARCH'], [
    'contact kholo', 'settings kholo', 'account kholo', 'niche le chalo', 'upar le chalo',
    'agla page kholo', 'pichla page kholo', 'pehle link par jao', 'doosra option chuno',
    'fees section par le chalo', 'about dikhao'
  ]);

  // 3. DEVANAGARI HINDI (~55)
  add('devanagari', ['READ_PAGE'], [
    'यह पेज पढ़ो', 'पेज पढ़ो', 'पूरा पढ़ो', 'पढ़ो', 'सुनाओ',
    'इस पेज को पढ़ो', 'पेज सुनाओ', 'पढ़ना शुरू करो'
  ]);
  add('devanagari', ['EXPLAIN', 'EXPLAIN_SECTION'], [
    'इस पेज को समझाओ', 'पेज समझाओ', 'यह पेज किस बारे में है', 'पेज का सारांश', 'समझाओ',
    'फीस समझाओ', 'पात्रता सेक्शन समझाओ', 'आवेदन के बारे में बताओ', 'नियम समझाओ'
  ]);
  add('devanagari', ['EXPLAIN_SOME_PART'], [
    'पेज का कुछ भाग समझाओ', 'कोई भाग समझाओ', 'कोई सेक्शन समझाओ'
  ]);
  add('devanagari', ['OUTLINE'], [
    'आउटलाइन', 'रूपरेखा', 'हेडिंग', 'शीर्षक', 'विषय सूची'
  ]);
  add('devanagari', ['STOP', 'PAUSE', 'RESUME', 'READ_AGAIN'], [
    'बंद करो', 'स्टॉप', 'खत्म करो', 'शांत', 'बंद',
    'रोको', 'पॉज़', 'ठहरो', 'रुकिए',
    'जारी रखो', 'आगे पढ़ो', 'फिर से शुरू',
    'फिर से पढ़ो', 'दोहराओ', 'शुरू से पढ़ो', 'दोबारा पढ़ो'
  ]);
  add('devanagari', ['HELP'], [
    'मदद', 'सहायता', 'हेल्प', 'क्या कर सकते हो'
  ]);
  add('devanagari', ['NAVIGATE_SECTION', 'NAVIGATE_SOME_PART', 'READ_SECTION'], [
    'किसी भाग पर ले चलो', 'पेज के किसी भाग पर ले चलो', 'कोई सेक्शन दिखाओ',
    'संपर्क पर ले चलो', 'सेटिंग्स खोलो', 'अकाउंट दिखाओ', 'परिचय पर जाओ',
    'इतिहास सेक्शन पढ़ो', 'सारांश पढ़ो', 'फ़ीस पढ़ो'
  ]);

  // 4. HINGLISH (~55)
  add('hinglish', ['READ_PAGE', 'READ_SECTION'], [
    'please yeh page read karo', 'is article ko read kar do', 'page read karo',
    'pricing section read karo', 'history section padho', 'about section sunao',
    'overview read kar do', 'full page padh ke sunao'
  ]);
  add('hinglish', ['EXPLAIN', 'EXPLAIN_SECTION'], [
    'is page ko summarize karo', 'yeh website explain karo', 'page ka summary batao',
    'fees section explain karo', 'refund policy samjhao', 'eligibility criteria explain kar do',
    'terms and conditions samjhao', 'overview explain karo'
  ]);
  add('hinglish', ['NAVIGATE_SECTION', 'QUERY_OR_SEARCH'], [
    'account menu open karo', 'settings button click karo', 'youtube studio select karo',
    'scroll down kar do', 'scroll up karo', 'first link open karo', 'second option select karo',
    'next page pe jao', 'previous page pe wapas jao', 'search box mein train status likho',
    'contact us link kholo', 'help center open kar do', 'dark theme on karo',
    'notifications open karo', 'profile icon click karo', 'about page pe le chalo',
    'pricing section pe scroll karo', 'faq section dikhao', 'footer pe jao',
    'top pe le chalo', 'back jao', 'page reload karo'
  ]);
  add('hinglish', ['STOP', 'PAUSE', 'RESUME', 'HELP'], [
    'stop kar do', 'reading pause karo', 'continue karo', 'resume kar do',
    'cancel kar do', 'sleepwalker rest karo', 'thoda ruko', 'help chahiye',
    'kya commands hain', 'what can i do here batao', 'aur options batao',
    'say more please', 'repeat kar do', 'phir se batao', 'band kar do',
    'read again please', 'outline show karo'
  ]);

  // 5. KANNADA (Script + Romanized) (~50)
  add('kannada', ['READ_PAGE'], [
    'ಈ ಪುಟ ಓದಿ', 'ಪುಟ ಓದಿ', 'ಓದಿ', 'ಪೂರ್ತಿ ಓದಿ', 'ಓದಲು ಶುರು ಮಾಡಿ',
    'ee page odi', 'page odi', 'poora odi', 'ee puta odi', 'odri'
  ]);
  add('kannada', ['EXPLAIN'], [
    'ಈ ಪುಟ ವಿವರಿಸಿ', 'ಸಾರಾಂಶ ಹೇಳಿ', 'ವಿವರಿಸಿ', 'ಈ ಪುಟ ಯಾವುದರ ಬಗ್ಗೆ',
    'ee page vivarisi', 'saramsha heli', 'explain maadi', 'ee page bagge heli'
  ]);
  add('kannada', ['OUTLINE'], [
    'ಶೀರ್ಷಿಕೆಗಳು', 'ವಿಷಯ ಸೂಚಿ', 'ವಿಭಾಗಗಳು ತೋರಿಸಿ',
    'headings torisi', 'sections heli', 'outline torisi'
  ]);
  add('kannada', ['STOP', 'PAUSE', 'RESUME', 'READ_AGAIN'], [
    'ನಿಲ್ಲಿಸಿ', 'ಬೇಡ', 'ರದ್ದು ಮಾಡಿ', 'ತಡೆಯಿರಿ', 'ಮುಂದುವರಿಸಿ', 'ಮತ್ತೆ ಓದಿ',
    'nillisi', 'stop maadi', 'tadeyiri', 'munduvarisi', 'matte odi', 'repeat maadi'
  ]);
  add('kannada', ['HELP'], [
    'ಸಹಾಯ', 'ಸಹಾಯ ಮಾಡಿ', 'ಏನು ಮಾಡಬಹುದು',
    'sahaya', 'sahaya maadi', 'enu madbahudu'
  ]);
  add('kannada', ['NAVIGATE_SECTION', 'QUERY_OR_SEARCH'], [
    'ಮುಂದಿನ ಪುಟ', 'ಹಿಂದಿನ ಪುಟ', 'ಸೆಟ್ಟಿಂಗ್ಸ್ ತೆರೆಯಿರಿ', 'ಸಂಪರ್ಕ ತೆರೆಯಿರಿ',
    'ಕೆಳಗೆ ಸ್ಕ್ರಾಲ್ ಮಾಡಿ', 'ಮೇಲೆ ಹೋಗಿ', 'ಮೊದಲ ಲಿಂಕ್ ತೆರೆಯಿರಿ',
    'mundina puta', 'hindina puta', 'settings tereyiri', 'kelage scroll maadi', 'mele hogi'
  ]);

  // 6. CORE ENGLISH & EDGE CASES (~55)
  add('english_core', ['HELP'], [
    'help', 'commands', 'what can you do', 'how to use', 'what can I do here'
  ]);
  add('english_core', ['READ_PAGE'], [
    'read this page', 'read page', 'read all', 'start reading', 'read content', 'read'
  ]);
  add('english_core', ['READ_SECTION'], [
    'read the history section', 'read section pricing', 'read introduction', 'read eligibility', 'read summary'
  ]);
  add('english_core', ['OUTLINE'], [
    'outline', 'show outline', 'headings', 'show headings', 'table of contents', 'sections'
  ]);
  add('english_core', ['EXPLAIN'], [
    'explain this page', 'explain the page', 'summarise this page', 'summarize this page', 'what is this page about', 'explain'
  ]);
  add('english_core', ['EXPLAIN_SOME_PART'], [
    'explain some part of page', 'explain a part of the page', 'explain a section', 'what is in some section'
  ]);
  add('english_core', ['EXPLAIN_SECTION'], [
    'explain the pricing section', 'explain about refunds', 'tell me about trains', 'what is e-filing', 'summarize eligibility'
  ]);
  add('english_core', ['NAVIGATE_SOME_PART'], [
    'take me to some part of the page', 'take me to a section', 'jump to some part'
  ]);
  add('english_core', ['NAVIGATE_SECTION'], [
    'take me to contact', 'scroll to footer', 'jump to faq', 'go to downloads',
    'open settings', 'show me pricing', 'open YouTube Studio', 'open Account'
  ]);
  add('english_core', ['STOP', 'PAUSE', 'RESUME', 'READ_AGAIN'], [
    'stop', 'cancel', 'shut up', 'be quiet', 'pause', 'hold on', 'wait',
    'resume', 'continue', 'keep reading', 'play', 'read it again', 'read again', 'repeat', 'start over'
  ]);
  add('english_core', ['QUERY_OR_SEARCH'], [
    'say more', 'more options', 'scroll down', 'scroll up', 'go back', 'click trains',
    'select second option', 'fill name with Rahul'
  ]);

  return rows;
}

module.exports = { buildVoiceCorpus };
