# 🌙 Sleepwalker 2.0 — Autonomous Voice Web & Computer Assistant

**Local-First Autonomous AI Agent with Siri-Inspired Circular Voice Interface, Real-Time Computer Awareness, Dual Live Observation, and Native Windows Execution.**

[![Manifest V3](https://img.shields.io/badge/Manifest-V3-success?style=flat-square&logo=googlechrome)](manifest.json)
[![Local AI Bridge](https://img.shields.io/badge/Local%20AI%20Bridge-Node.js%20%7C%20Port%204888-blue?style=flat-square)](dual-observation/bridge.js)
[![Ollama Supported](https://img.shields.io/badge/Ollama-qwen2.5%20%7C%20llama3.2-purple?style=flat-square)](https://ollama.com)
[![Gemini Supported](https://img.shields.io/badge/Google%20Gemini-Flash%20Lite-orange?style=flat-square)](https://ai.google.dev)
[![Native Companion](https://img.shields.io/badge/.NET%208-Native%20Messaging%20Host-blueviolet?style=flat-square)](sleepwalker-native/)
[![Zero Build Step](https://img.shields.io/badge/Build%20Step-Zero%20(Pure%20Vanilla%20JS)-brightgreen?style=flat-square)](background.js)
[![License](https://img.shields.io/badge/License-MIT-yellow?style=flat-square)](LICENSE)

---

## 🌟 What is Sleepwalker 2.0?

Sleepwalker 2.0 transforms any web browser and Windows desktop into an autonomous, voice-driven computational companion. It is designed for hands-free navigation, low-vision accessibility, and intelligent computer use.

Unlike simple wrappers or chatbot extensions, Sleepwalker runs a **hybrid local-cloud AI pipeline** (Ollama + Google Gemini) that parses spoken language, observes the live DOM and Accessibility Tree, plans discrete actions, visually animates real-world cursor movements and keystrokes, and autonomously verifies webpage state changes.

### Key Highlights

* 🎙️ **Siri-Inspired Circular Voice Experience**: Compact 52px idle orb that smoothly expands into an 78px circular interface with blue, cyan, and violet gradient lighting. Features an internal fluid waveform reacting dynamically to real microphone and speech levels, with zero continuous animations while idle.
* 👁️ **Visible Computer Awareness & Action Feedback**:
  * **Visible Cursor v2**: Coordinate-aligned pointer with smooth trajectory animations, hover states, and click ripples reflecting actual execution coordinates.
  * **Typing Feedback Indicator**: Live floating pill highlighting target inputs, displaying accessible names, confirming focus, and verifying entered values.
  * **Observation Panel**: Live inspection displaying page URL, title, detected elements (links, buttons, inputs), target confidence, and explicit observation source (`DOM`, `Accessibility Tree`, `Screenshot`, or `Vision Model`).
  * **9-Stage Live Pipeline**: Real-time transition through `LISTENING` → `COMMAND_RECEIVED` → `UNDERSTANDING` → `OBSERVING_PAGE` → `TARGET_IDENTIFIED` → `PLANNING_ACTION` → `EXECUTING` → `VERIFYING` → `COMPLETED` / `FAILED`.
* 🛡️ **Dual-Observation Controller & Safety Dashboard**: Standalone dashboard on port `4888` providing live telemetry, side-by-side state verification, independent bug reporting, and an instant **Emergency Stop / Kill-Switch**.
* 🖥️ **Native Windows Companion (.NET 8)**: Optional Windows native messaging host for desktop-wide computer automation (clicking, typing, window management, screenshot capture) via Chrome Native Messaging.
* 🔒 **Local-First & Strict Privacy**: Sensitive passwords (`<input type="password">`) and credentials are 100% stripped and never captured. Secrets and API keys are scrubbed before any telemetry is emitted.

---

## 🏗️ Architecture Overview

```
                      ┌────────────────────────────────────────┐
                      │        User Voice / Keyboard Input     │
                      │         (Alt+S / Mic / Typed Input)    │
                      └───────────────────┬────────────────────┘
                                          │
                                          ▼
                      ┌────────────────────────────────────────┐
                      │         Sleepwalker Chrome Extension   │
                      │     (Siri-Inspired Voice UI / DOM /    │
                      │    Visible Cursor / Typing Feedback)   │
                      └──────────┬───────────────────▲─────────┘
                                 │                   │
                     Native IPC  │                   │ Browser Events /
                 (Chrome Bridge) │                   │ Observation Telemetry
                                 ▼                   │
                      ┌──────────────────────────────┴─────────┐
                      │       Local AI Bridge (Port 4888)      │
                      │      dual-observation/bridge.js        │
                      └──────────┬───────────────────┬─────────┘
                                 │                   │
                  Ollama HTTP API│                   │ Gemini API
             (http://127.0.0.1:11434)                │ (HTTPS Cloud)
                                 ▼                   ▼
                      ┌────────────────────┐   ┌────────────────────┐
                      │ Local Ollama Models│   │ Google Gemini Flash│
                      │ • qwen2.5:1.5b     │   │ • gemini-3.5-flash │
                      │ • llama3.2:3b      │   │   (or 2.5-flash)   │
                      │ • nomic-embed-text │   │                    │
                      │ • qwen3-vl:2b      │   │                    │
                      └────────────────────┘   └────────────────────┘
                                 ▲
                                 │ Desktop OS Control
                      ┌──────────┴─────────────────────────────┐
                      │    Sleepwalker Native Companion (C#)   │
                      │   Windows Mouse, Keyboard & UI Autom.  │
                      └────────────────────────────────────────┘
```

---

## 📋 System Requirements

* **Operating System**: Windows 10 / 11 (64-bit), macOS, or Linux (Native companion requires Windows).
* **Browser**: Google Chrome 116+ or Microsoft Edge (Chromium).
* **Runtime**: [Node.js](https://nodejs.org/) v18.0.0 or higher.
* **Local AI (Optional but recommended)**: [Ollama](https://ollama.com/) v0.3.0+ running locally on port `11434`.
* **Cloud AI**: Google Gemini API key (free tier supported).
* **Native Desktop Companion (Optional)**: [.NET 8.0 SDK](https://dotnet.microsoft.com/download/dotnet/8.0).

---

## 🚀 Step-by-Step Installation & Setup

### Step 1: Clone the Repository

```bash
git clone https://github.com/vatsalpro/sleep.git
cd sleep
```

### Step 2: Configure Environment Variables

Copy the `.env.example` file to `.env`:

```bash
copy .env.example .env
```

Open `.env` in any text editor and configure your settings:

```env
# Google Gemini API Configuration (if using Gemini)
GEMINI_API_KEY=AIzaSy_your_gemini_api_key_here
GEMINI_MODEL=gemini-3.5-flash-lite

# Local Ollama AI Services
OLLAMA_URL=http://127.0.0.1:11434
OLLAMA_FAST_MODEL=qwen2.5:1.5b
OLLAMA_PLAN_MODEL=llama3.2:3b
OLLAMA_EMBED_MODEL=nomic-embed-text:latest
OLLAMA_VISION_MODEL=qwen3-vl:2b

# Bridge Port
BRIDGE_PORT=4888
LOCAL_ONLY=false
```

> **Note:** `.env` is ignored by Git and will never be committed or uploaded.

### Step 3: Setup Local Ollama Models (Optional for Local AI)

If you wish to run completely local models without cloud dependencies, install Ollama and pull the approved models:

```bash
# 1. Fast intent classification & command extraction
ollama pull qwen2.5:1.5b

# 2. Planning, reasoning & multi-step execution
ollama pull llama3.2:3b

# 3. Semantic memory & embeddings
ollama pull nomic-embed-text:latest

# 4. Optional visual understanding
ollama pull qwen3-vl:2b
```

Verify Ollama is running:
```bash
curl http://127.0.0.1:11434/api/tags
```

### Step 4: Start the Local AI Bridge & Dual-Observation Server

Run the local bridge daemon:

```bash
node dual-observation/bridge.js
```

You should see:
```text
======================================================
  Sleepwalker Local AI Bridge & Dual-Observation Server
  Listening on http://127.0.0.1:4888
  Bearer Token: .bridge-token
======================================================
```

Open `http://127.0.0.1:4888/dashboard.html` in your browser to view the **Live Observation & Safety Dashboard**.

### Step 5: Load the Chrome Extension

1. Open Google Chrome and navigate to `chrome://extensions/`.
2. Toggle **Developer mode** in the top right corner.
3. Click **Load unpacked**.
4. Select the `D:\sleep` folder (the root repository directory).
5. The **Sleepwalker - Voice Web Assistant** extension will appear in your extension list.

### Step 6: (Optional) Register Native Windows Companion

For OS-wide automation outside Chrome (such as controlling Windows Notepad, Explorer, or native dialogs):

1. Open PowerShell as Administrator.
2. Run the registration script:
   ```powershell
   .\register-native-host.ps1
   ```
3. To build the C# companion binary:
   ```bash
   dotnet build sleepwalker-native\SleepwalkerNative.csproj -c Release
   ```

---

## 🎮 How to Use Sleepwalker

### 1. Activating the Siri-Inspired Voice Orb
* **Keyboard Shortcut**: Press `Alt + S` on any webpage to summon the assistant.
* **Hold to Talk**: Press and hold `Alt + Z` while speaking.
* **Dismiss**: Press `Escape` or click outside the orb.
* **Typed Command**: Click the **Type** pill next to the orb to open the inline typed input box.

### 2. Voice Interaction States
The circular orb indicates the current phase of execution:
| State | Orb Appearance | Description |
| :--- | :--- | :--- |
| **IDLE** | Compact (52px), calm | Zero CPU/GPU animations running. |
| **LISTENING** | Expanded (78px), cyan halo | Real-time waveform reacts to mic audio; live transcript chip displays words. |
| **PROCESSING** | Expanded (78px), violet halo | Fluid wave motion; AI pipeline parsing intent and generating action plan. |
| **OBSERVING** | Cyan visual pulse | Inspecting webpage with observation source badge (`DOM`, `Accessibility Tree`, `Screenshot`). |
| **EXECUTING** | Cobalt blue active pulse | Visible cursor moves to coordinates; action executed. |
| **SPEAKING** | Expanded (78px), cyan/violet | Waveform reacts to speech synthesis output. |
| **COMPLETED** | Emerald ring, checkmark icon | Task successfully verified; smoothly returns to idle. |
| **ERROR** | Ruby ring, error icon | Concise failure explanation displayed. |

### 3. Example Voice Commands
* *"Explain this page"* — Summarizes the page purpose, key dates, deadlines, and fees.
* *"Find scholarship for engineering"* — Searches the current page for matching links and navigation elements.
* *"Click Apply Now"* — Animates cursor to the button, provides visual target highlight, and clicks.
* *"Fill out the form"* — Initiates guided form filling with automatic accessible name detection.
* *"What are the required documents?"* — Extracts document checklists and uploads.

### 4. Safety & Emergency Stop
At any time during an autonomous execution:
* Click the red **Emergency Stop** button on the Dual-Observation Dashboard (`http://127.0.0.1:4888/dashboard.html`).
* Or click **Cancel** on the status pill above the orb.
* All ongoing actions, keystrokes, and navigations are aborted immediately.

---

## 🧪 Running Automated Tests

Sleepwalker includes a comprehensive test suite covering unit, integration, UI, and live AI pipeline tests:

### 1. Siri-Inspired UI Acceptance Suite
Tests expandable orb geometry, 8 interaction states, microphone audio reactivity, and zero idle animations:
```bash
python tests/test_siri_voice_ui.py
```

### 2. Core Playwright UI Regression Suite
Tests shadow-DOM isolation, click pass-through, layout shift, and summon/dismiss cycles:
```bash
python tests/test_ui_p1.py
```

### 3. Visible Awareness & Action Feedback Audit
Tests end-to-end integration between the Local AI Bridge, visible cursor v2, typing feedback, and stage pipeline:
```bash
node dual-observation/test_visible_awareness_feedback.js
```

### 4. 20-Scenario Acceptance Suite
Tests all 20 autonomous web navigation and form interaction scenarios:
```bash
node dual-observation/test_phase_e_scenarios.js
```

---

## 📁 Repository File Map

```text
sleep/
├── manifest.json              # Chrome Manifest V3 configuration
├── background.js              # Service worker: command cascade & bridge relay
├── content.js                 # Content coordinator connecting DOM to SW_UI
├── orb.js                     # Siri-inspired circular orb UI & state machine
├── threads.js                 # Lightweight canvas-free lifecycle controller
├── card.js                    # Modern response card & interactive results
├── ui.css                     # Modern blue/cyan/violet design tokens & animations
├── browser-engine.js          # Visible cursor v2, typing feedback & observation engine
├── intent.js                  # 13-intent rule matcher & phonetic classifier
├── voice.js                   # Web Audio & SpeechRecognition level provider
├── reader.js                  # Web speech synthesis & table reader
├── .env.example               # Template for local AI configuration
├── dual-observation/
│   ├── bridge.js              # Local AI Bridge server (Port 4888)
│   ├── sandbox-adapter.js     # Mechanical relay to browser sandbox
│   ├── dashboard.html         # Live Observation & Emergency Stop dashboard
│   ├── test_visible_awareness_feedback.js
│   └── test_phase_e_scenarios.js
├── sleepwalker-native/        # C# .NET 8 Windows Native Messaging Host
│   ├── Program.cs
│   ├── ActionExecutor.cs
│   └── SleepwalkerNative.csproj
├── register-native-host.ps1   # Windows Native host registration script
└── tests/
    ├── test_siri_voice_ui.py  # Siri voice UI acceptance test suite
    └── test_ui_p1.py          # Playwright regression test suite
```

---

## 📄 License

This project is licensed under the MIT License — see the [LICENSE](LICENSE) file for details.
