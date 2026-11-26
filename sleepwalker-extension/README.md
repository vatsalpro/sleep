# Sleepwalker — AI Browser Copilot (Chrome Extension)

**Sleepwalker** is a Manifest V3 AI Browser Copilot Chrome Extension featuring a 60 FPS Siri-inspired liquid-glass voice & text orb, natural-language webpage navigation, multi-level hierarchical menu & blind submenu discovery, universal web form filling (Google Forms, React/Vue/Angular SPAs, ARIA widgets, HTML5), multi-tab orchestration, and privacy-first webpage summarization powered by **Local Ollama** or **Google Gemini**.

## Demo Video

- **Watch Demo Video**: [Sleepwalker Demo (Google Drive)](https://drive.google.com/file/d/1Ue-pk6MQmsGaCiGdGQhCr2D5Xg0gSd7T/view?usp=sharing)

---

## Quick Start — Load Unpacked in Chrome / Edge / Brave

1. Clone this repository:
   ```bash
   git clone https://github.com/vatsalpro/sleep.git
   ```
2. Open `chrome://extensions` in Google Chrome (or `edge://extensions` in Microsoft Edge).
3. Turn **ON** **Developer mode** (top-right toggle).
4. Click **Load unpacked** and select the **`sleepwalker-extension`** folder (`sleep/sleepwalker-extension`).
5. Open any webpage and press **`Alt+S`** (or click the **Sleepwalker** toolbar icon) to summon the fluid assistant orb.

---

## Core Capabilities

- **Siri-Inspired Fluid Voice & Text UI** (`orb-canvas.js`, `orb.js`, `card.js`, `threads.js`, `ui.css`)
  - 60 FPS multi-layer organic liquid-glass canvas orb with distinct states (`idle`, `listening`, `processing`, `executing`, `speaking`, `completed`, `error`).
  - Conflict-free **Type** command bar that automatically pauses the microphone and silence timers while typing and prevents outside-click dismissal of open webpage menus.
- **Natural Voice Pipeline & Continuous Dialogue** (`voice-pipeline.js`, `voice.js`, `reader.js`, `dialogue.js`)
  - Speakable text sanitization, sentence-paced TTS chunking, and contiguous-phrase echo suppression so TTS playback never false-triggers or blocks real spoken commands.
- **Hierarchical Menu & Blind Submenu Explorer** (`unified-task-contract.js`, `unified-orchestrator.js`, `world-model.js`, `browser-engine.js`)
  - Navigates detached portal menus (`<tp-yt-iron-dropdown>`, Radix/MUI/AntD popovers), hover mega-menus, and multi-page drill-down menus.
  - Finds options even when you don't know the intermediate submenu or parent menu (e.g., *"Select Dark theme under Account"*, *"Switch to Dark theme"*, *"Select YouTube Studio"*, *"What options are under Account?"*) with dead-end `Back` recovery and strict safety guards that never click destructive/sign-out links.
- **Universal Form Engine** (`form-index.js`, `form-fill.js`, `forms.js`)
  - W3C AccName 1.2 `aria-labelledby` & question-card heading resolution for **Google Forms**, Microsoft Forms, React/Vue/Angular controlled inputs, ARIA `radiogroup`/`checkbox`/`listbox`/`combobox`, and native HTML5 controls.
  - Batch multi-field filling (`fill_form`) with read-back verification, validation error detection, and hard blocking of sensitive fields (passwords, OTPs, payment cards) — never auto-submitting without explicit confirmation.
- **Multi-Tab Context, Execution Guards & AI Summarization** (`background.js`, `extension-intelligence.js`, `llm.js`, `explain.js`, `digest.js`)
  - List, open, switch, and close browser tabs by natural language; summarize or explain any webpage locally via **Ollama** (`http://127.0.0.1:11434`) or optionally via **Google Gemini** (configured in Extension Options).

---

## Optional AI Provider Setup

- **Local Ollama (Default / Local-Only Privacy Mode)**:
  1. Run `ollama serve` locally and pull a fast model (e.g., `ollama pull llama3.2:3b` or `ollama pull qwen2.5:1.5b`).
  2. Sleepwalker connects locally to `http://127.0.0.1:11434` out of the box.
- **Google Gemini (Optional)**:
  1. Right-click the Sleepwalker extension icon → **Options** (or copy `.env.example` to `.env` locally — `.env` and `config.local.js` are gitignored).
  2. Enter your Gemini API key and opt in to cloud processing if desired.
