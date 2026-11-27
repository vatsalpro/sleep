# Sleepwalker Automated E2E & Voice Audit Report
Generated: 2026-11-27T03:17:41.301Z
Extension: `D:\sleep\sleepwalker-extension` (MV3, Headed Chromium Persistent Profile, Pace <= 1 action/sec)

## 1. Per-Site Audit Summary
| Site | Status | DOM Found | SW Detected | Coverage | Unclear Labels | Hidden/Dup/Ad Leaks | Unreachable (EN/HI) | Safe Clicks (OK/Try) | Wrong Clicks | "What can I do" / "Say more" | Time (ms) |
|---|---|---:|---:|---:|---:|---|---:|---:|---:|---|---:|
| IRCTC | OK | 64 | 71 | 100% | 0 | 0 / 0 / 0 | 0/10 | 2/2 | 0 | PASS / PASS | 16392 |
| Income Tax e-Filing | OK | 103 | 123 | 100% | 0 | 0 / 0 / 0 | 0/10 | 1/2 | 1 | PASS / PASS | 17984 |
| Passport India | OK | 97 | 53 | 55% | 0 | 0 / 0 / 0 | 0/10 | 1/2 | 1 | PASS / PASS | 13663 |
| EPFO Member Portal | OK | 29 | 27 | 93% | 0 | 0 / 0 / 0 | 0/10 | 1/2 | 1 | PASS / PASS | 12744 |
| Amazon India | OK | 182 | 173 | 95% | 0 | 0 / 1 / 0 | 0/10 | 2/2 | 0 | PASS / PASS | 18692 |
| MakeMyTrip | BLOCKED_OR_CAPTCHA (Empty/anti-bot shell (0 visible interactive DOM elements after load)) | 0 | 0 | 0% | 0 | 0 / 0 / 0 | 0/0 | 0/0 | 0 | FAIL / FAIL | 3335 |

## 2. Dynamic Content & Stress Tests
| Test | Result | Detail |
|---|---|---|
| Shadow DOM detection | PASS | Detected "Shadow Preferences" |
| Same-origin iframe detection | PASS | Detected "Iframe Help Guide" |
| Dynamic modal detection | PASS | Detected "Contact Support Team" inside opened modal |
| SPA pushState route update | PASS | Detected new SPA control "Edit Display Name" at /profile |
| Lazy-loaded element detection | PASS | Detected "Lazy Loaded Documentation" after scroll |
| TTS Echo suppression | PASS | exact=true, sub3=true, shortAllowed=true, newCmdAllowed=true |
| Command spam resilience (8 rapid cmds) | PASS | errors=0, alive=true, state=ERROR |
| Page change mid-read cleanup | PASS | started=true, speakingAfter=false, danglingHl=0 |

## 3. Voice Command Corpus (350 Phrases -> `parseCommand()`)
Overall: **341 / 350** (97%)

| Category | Passed | Total | Pass Rate |
|---|---:|---:|---:|
| typos | 60 | 60 | 100% |
| romanized_hindi | 54 | 55 | 98% |
| devanagari | 55 | 55 | 100% |
| hinglish | 51 | 55 | 93% |
| kannada | 54 | 54 | 100% |
| english_core | 67 | 71 | 94% |

## 4. Top 10 Problems Ranked by User Impact
1. **Romanized Hindi missing from parseCommand() regexes** — 54/55 romanized Hindi phrases matched (voice.js currently focuses on Devanagari script).
2. **Hinglish code-switched commands misclassified in parseCommand()** — 51/55 Hinglish phrases parsed to expected command types.
3. **Safe navigation clicks failed verification on live portals** — 3 safe click attempt(s) did not produce verified navigation/state change.
4. **Index noise: 1 duplicates, 0 ad/cookie items, 0 hidden leaks** — Duplicate or cookie-banner items add clutter to voice disambiguation lists.
5. **Bot-protection / network blocks on 1 target portal(s)** — MakeMyTrip: Empty/anti-bot shell (0 visible interactive DOM elements after load)

## 5. Failure Log (19 shown; total voice misses: 9)
| URL | Element / Selector | Input | Expected | Actual |
|---|---|---|---|---|
| https://www.irctc.co.in/nget/train-search | `button.btn.btn-primary` | SCAN coverage | Element detected by Sleepwalker | Missed visible element ("हिंदी") |
| https://www.irctc.co.in/nget/train-search | `button.btn.btn-primary` | SCAN coverage | Element detected by Sleepwalker | Missed visible element ("English") |
| https://www.irctc.co.in/nget/train-search | `div.ui-dropdown-trigger.ui-state-default` | SCAN coverage | Element detected by Sleepwalker | Missed visible element ("unlabeled") |
| https://www.incometax.gov.in/iec/foportal/ | `button.slick-prev.slick-arrow` | SCAN coverage | Element detected by Sleepwalker | Missed visible element ("Previous") |
| https://www.incometax.gov.in/iec/foportal/ | `a.sf-depth-1.menuparent` | open Company » | Safe navigation/tab/accordion activated | No verified change ({"commandId":"sw-mwyetu0d-y9x4","selectedEngine":"legacy","executionBackend":"cdp_attached_tab","inp |
| https://www.passportindia.gov.in/psp | `a#collasible-nav-dropdown3` | open Passport Offices | Safe navigation/tab/accordion activated | No verified change ({"commandId":"sw-mwyeu6bh-xkpx","selectedEngine":"legacy","executionBackend":"cdp_attached_tab","inp |
| https://unifiedportal-mem.epfindia.gov.in/memberinterface/ | `a` | open Screen Reader Access | Safe navigation/tab/accordion activated | No verified change ({"commandId":"sw-mwyeue5l-gam7","selectedEngine":"legacy","executionBackend":"cdp_attached_tab","inp |
| https://www.amazon.in/ | `a#nav-assist-skip-to-main-content` | SCAN coverage | Element detected by Sleepwalker | Missed visible element ("Main content") |
| https://www.amazon.in/ | `a#nav-assist-search` | SCAN coverage | Element detected by Sleepwalker | Missed visible element ("Search alt + /") |
| https://www.amazon.in/ | `a#nav-assist-cart` | SCAN coverage | Element detected by Sleepwalker | Missed visible element ("Cart shift + alt + C") |
| unit://voice.parseCommand | `parseCommand[romanized_hindi]` | shuru se padho | READ_PAGE | READ_AGAIN |
| unit://voice.parseCommand | `parseCommand[hinglish]` | repeat kar do | STOP / PAUSE / RESUME / HELP | READ_AGAIN |
| unit://voice.parseCommand | `parseCommand[hinglish]` | phir se batao | STOP / PAUSE / RESUME / HELP | READ_AGAIN |
| unit://voice.parseCommand | `parseCommand[hinglish]` | read again please | STOP / PAUSE / RESUME / HELP | READ_AGAIN |
| unit://voice.parseCommand | `parseCommand[hinglish]` | outline show karo | STOP / PAUSE / RESUME / HELP | OUTLINE |
| unit://voice.parseCommand | `parseCommand[english_core]` | open settings | NAVIGATE_SECTION | QUERY_OR_SEARCH |
| unit://voice.parseCommand | `parseCommand[english_core]` | open YouTube Studio | NAVIGATE_SECTION | QUERY_OR_SEARCH |
| unit://voice.parseCommand | `parseCommand[english_core]` | open Account | NAVIGATE_SECTION | QUERY_OR_SEARCH |
| unit://voice.parseCommand | `parseCommand[english_core]` | say more | QUERY_OR_SEARCH | HELP |
