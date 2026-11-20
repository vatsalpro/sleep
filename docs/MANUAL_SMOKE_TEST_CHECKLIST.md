# Sleepwalker Phase 4.3.1 — Manual Smoke-Test Checklist

Use this reproducible checklist after loading the unpacked extension (`D:\sleep`) in Google Chrome (`chrome://extensions` -> Developer mode -> Load unpacked -> `D:\sleep`) and confirming local Ollama (`ollama serve`) has `llama3.2:3b` and `nomic-embed-text` installed.

## 1. Extension Origin Allowlist Setup (One-Time on Windows)
1. Copy the loaded extension ID on `chrome://extensions` (or open **Sleepwalker Settings -> Connections -> Extension Origin / Allowlist Setup**).
2. Run in PowerShell (replacing with your exact extension ID if different; comma-separate multiple IDs if needed):
   ```powershell
   [Environment]::SetEnvironmentVariable('OLLAMA_ORIGINS', 'chrome-extension://hfkigbihnjlmlcnhdngiijlihimkijbh', 'User')
   ```
3. Quit any running Ollama tray/process and restart `ollama serve`:
   ```powershell
   taskkill /F /IM ollama.exe 2>$null
   $env:OLLAMA_ORIGINS = [Environment]::GetEnvironmentVariable('OLLAMA_ORIGINS', 'User')
   ollama serve
   ```
4. Open Sleepwalker Options (`options.html`) -> click **Refresh Health** -> confirm:
   - **Ollama REST**: `Connected` with `generationOk=true`, HTTP `200`, live probe latency shown.
   - **Ollama Embeddings**: `Connected` (`nomic-embed-text`, 768 dimensions, `embeddingOk=true`).
   - **Dev Trace Counter**: `Origin 403s: 0`.

## 2. Live Physical Microphone & Voice Lifecycle Checks
1. Grant microphone permission to Chrome and Sleepwalker (`SLEEPWALKER_OPEN_MIC_SETUP` or site prompt).
2. Press `Alt+S` on a standard webpage (`https://en.wikipedia.org/wiki/Credit_card`). Verify the floating orb enters `listening` state and live partial transcript appears.
3. Speak clearly: *"Select the Dark option under Color."* Verify Wikipedia switches to dark mode (`skin-theme-clientpref-night`) and the response card reports the updated control.
4. Trigger a long reading or explanation (*"Explain this section"*). While TTS is speaking, test **Barge-In / Interrupt** by pressing `Escape` or `Alt+S`. Verify speech stops immediately without corrupting the next command.
5. Say *"You can rest"* -> verify Sleepwalker enters resting state cleanly; press `Alt+S` again -> verify task/context resume offer.

## 3. Live Public Website Manual Verification
### A. Wikipedia (`https://en.wikipedia.org/wiki/Credit_card`)
- Wait 3s after page load for Appearance client-preferences radios to hydrate.
- *"Select the Dark option under Color"* -> `Dark` radio checked, dark theme active.
- *"Choose Small under Text"* -> `Small` radio checked, small font active.
- *"Go to the History section"* -> scrolls smoothly to `History`, displays History prose (not bare `"History edit"`).
- *"Explain this section"* -> summarizes History section content via `llama3.2:3b`.
- *"Go to the Usage section"* -> scrolls to `Usage`.
- *"Go back to the previous section"* -> returns cleanly to `History`.
- *"Select Smart card"* -> navigates to `/wiki/Smart_card`.

### B. YouTube (`https://www.youtube.com/results?search_query=neural+networks`)
- If prompted with region/cookie consent or account login walls, accept/dismiss manually as a user (never automate bypass).
- Verify initial video list renders -> *"Find a video explaining neural networks"* opens a matching result (e.g., 3Blue1Brown).
- On search results -> *"Open the fifteenth video"* -> scrolls feed, loads Batch 2 (11-20+), opens #15 watch page.
- On a captioned watch page -> *"Explain the first 2 minutes"* -> expands transcript and summarizes only the first 2 minutes.
- On a video with captions disabled -> *"Summarize the available captions"* -> honestly states captions/transcript are unavailable without fabricating spoken content.
- *"Pause the video"* / *"Mute"* -> HTML5 video pauses/mutes cleanly.

### C. Dynamic Site (`https://developer.mozilla.org/en-US/docs/Web/JavaScript`) & Protected / Gated Sites
- Open interactive menus/details panels -> verify Sleepwalker continues navigating/explaining updated sections without stale references.
- Visit any sensitive/login/banking/CAPTCHA-gated page -> verify Sleepwalker refuses password/OTP extraction, never attempts CAPTCHA bypass, and reports restrictions clearly.
