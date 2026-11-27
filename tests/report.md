# Sleepwalker Automated E2E & Voice Audit Report
Generated: 2026-11-27T04:19:31.426Z
Extension: `D:\sleep\sleepwalker-extension` (MV3, Headed Chromium Persistent Profile, Pace <= 1 action/sec)

## 1. Per-Site Audit Summary
| Site | Status | DOM Found | SW Detected | Coverage | Unclear Labels | Hidden/Dup/Ad Leaks | Unreachable (EN/HI) | Safe Clicks (OK/Try) | Wrong Clicks | "What can I do" / "Say more" | Time (ms) |
|---|---|---:|---:|---:|---:|---|---:|---:|---:|---|---:|
| IRCTC | OK | 64 | 72 | 100% | 0 | 0 / 0 / 0 | 0/10 | 2/2 | 0 | PASS / PASS | 16816 |
| Income Tax e-Filing | OK | 101 | 124 | 100% | 0 | 0 / 0 / 0 | 0/10 | 2/2 | 0 | PASS / PASS | 17939 |
| Passport India | OK | 97 | 53 | 55% | 0 | 0 / 0 / 0 | 0/10 | 1/2 | 1 | PASS / PASS | 13880 |
| EPFO Member Portal | OK | 29 | 27 | 93% | 0 | 0 / 0 / 0 | 0/10 | 0/2 | 2 | FAIL / FAIL | 51469 |
| Amazon India | OK | 183 | 173 | 95% | 0 | 0 / 0 / 0 | 0/10 | 2/2 | 0 | PASS / PASS | 18914 |
| MakeMyTrip | BLOCKED_OR_CAPTCHA (Empty/anti-bot shell (0 visible interactive DOM elements after load)) | 0 | 0 | 0% | 0 | 0 / 0 / 0 | 0/0 | 0/0 | 0 | FAIL / FAIL | 3288 |

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
| Compound multi-step command | PASS | Executed 2-step compound workflow cleanly |
| Teach & recall multi-step skill | PASS | Learned "support shortcut" (2 steps) and verified in skill catalog |
| Page change mid-read cleanup | PASS | started=true, speakingAfter=false, danglingHl=0 |

## 3. Voice Command Corpus (350 Phrases -> `parseCommand()`)
Overall: **350 / 350** (100%)

| Category | Passed | Total | Pass Rate |
|---|---:|---:|---:|
| typos | 60 | 60 | 100% |
| romanized_hindi | 55 | 55 | 100% |
| devanagari | 55 | 55 | 100% |
| hinglish | 55 | 55 | 100% |
| kannada | 54 | 54 | 100% |
| english_core | 71 | 71 | 100% |

## 4. Top 10 Problems Ranked by User Impact
1. **"What can I do here" / "Say more" pagination gap** — 1/5 accessible sites lacked a top 5–7 actionable list and 1/5 failed "say more" pagination.
2. **Safe navigation clicks failed verification on live portals** — 3 safe click attempt(s) did not produce verified navigation/state change.
3. **Bot-protection / network blocks on 1 target portal(s)** — MakeMyTrip: Empty/anti-bot shell (0 visible interactive DOM elements after load)

## 5. Failure Log (12 shown; total voice misses: 0)
| URL | Element / Selector | Input | Expected | Actual |
|---|---|---|---|---|
| https://www.irctc.co.in/nget/train-search | `div.ui-dropdown-trigger.ui-state-default` | SCAN coverage | Element detected by Sleepwalker | Missed visible element ("unlabeled") |
| https://www.irctc.co.in/nget/train-search | `div.ui-dropdown-trigger.ui-state-default` | SCAN coverage | Element detected by Sleepwalker | Missed visible element ("unlabeled") |
| https://www.irctc.co.in/nget/train-search | `div.ui-dropdown-trigger.ui-state-default` | SCAN coverage | Element detected by Sleepwalker | Missed visible element ("unlabeled") |
| https://www.passportindia.gov.in/psp | `a#collasible-nav-dropdown3` | open Passport Offices | Safe navigation/tab/accordion activated | No verified change ({"commandId":"sw-mwyh0v15-m0l2","selectedEngine":"legacy","executionBackend":"cdp_attached_tab","inp |
| https://unifiedportal-mem.epfindia.gov.in/memberinterface/ | `a` | open Screen Reader Access | Safe navigation/tab/accordion activated | No verified change ({"commandId":"sw-mwyh13gb-22it","selectedEngine":"legacy","executionBackend":"cdp_attached_tab","inp |
| https://unifiedportal-mem.epfindia.gov.in/memberinterface/ | `a.c-rgba2552552557-td-none-fs-85rem-fw-500` | open Contact Us | Safe navigation/tab/accordion activated | No verified change ({"commandId":"sw-mwyh1581-h2vo","selectedEngine":"legacy","executionBackend":"cdp_attached_tab","inp |
| https://unifiedportal-mem.epfindia.gov.in/memberinterface/ | `a#btnFontReset` | Highlight non-safe/input element (no click) | Element highlightable without clicking | Selector not directly queryable |
| chrome-error://chromewebdata/ | `#sw-ui-card` | what can I do here | Top 5-7 sensible actionable options listed | Got (0 numbered items): "empty" |
| chrome-error://chromewebdata/ | `#sw-ui-card` | say more | Pages through next batch of options | Did not paginate cleanly: "no change" |
| https://www.amazon.in/ | `a#nav-assist-skip-to-main-content` | SCAN coverage | Element detected by Sleepwalker | Missed visible element ("Main content") |
| https://www.amazon.in/ | `a#nav-assist-search` | SCAN coverage | Element detected by Sleepwalker | Missed visible element ("Search alt + /") |
| https://www.amazon.in/ | `a#nav-assist-cart` | SCAN coverage | Element detected by Sleepwalker | Missed visible element ("Cart shift + alt + C") |
