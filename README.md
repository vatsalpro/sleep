# 🌙 Sleepwalker - Voice Web Assistant
**Wispr-Flow Style Voice Assistant for Accessible Web • Manifest V3 Chrome Extension (Plain JavaScript, HTML & CSS — Zero Build Step)**

[![Manifest V3](https://img.shields.io/badge/Manifest-V3-success?style=flat-square&logo=googlechrome)](manifest.json)
[![Zero Build Step](https://img.shields.io/badge/Build%20Step-Zero%20(Pure%20Vanilla%20JS)-blue?style=flat-square)](background.js)
[![Accessibility](https://img.shields.io/badge/Accessibility-WCAG%20AAA-brightgreen?style=flat-square)](widget.css)
[![Bilingual](https://img.shields.io/badge/Languages-English%20%7C%20Hindi%20(en--IN%20%2F%20hi--IN)-orange?style=flat-square)](voice.js)
[![Privacy](https://img.shields.io/badge/Privacy-Zero%20Password%20Capture-red?style=flat-square)](explain.js)
[![Demo Video](https://img.shields.io/badge/Demo%20Video-Google%20Drive-red?style=flat-square&logo=googledrive)](https://drive.google.com/drive/folders/1Q9A8rml4AuczycImQmk1X-EUSb0Usa1q?usp=sharing)
[![GitHub Repo](https://img.shields.io/badge/GitHub-vatsalpro%2Fsleep-181717?style=flat-square&logo=github)](https://github.com/vatsalpro/sleep)

---

## 📺 Demo Video

Watch the complete prototype walkthrough and demonstration video:
🎥 **[Watch Sleepwalker Video Demo on Google Drive](https://drive.google.com/drive/folders/1Q9A8rml4AuczycImQmk1X-EUSb0Usa1q?usp=sharing)**

Highlights covered in the demo:
- **Wispr-Flow Floating Pill:** Seamless drag-and-drop, real-time equalizer wave animations, companion bubble.
- **Signature "Explain This Page":** Full-screen prism glow edge overlay with center readability mask.
- **Sentence-by-Sentence Speech:** Dynamic active sentence highlighting in English and Hindi.
- **Strict DOM Privacy:** Form inputs, textareas, and `<input type="password">` fields strictly excluded.
- **Side Panel Settings:** Local-Only Mode, Ollama connection testing, and microphone setup diagnostics.

---

## 🎯 What Sleepwalker Does

Millions of low-vision, low-literacy, and elderly users struggle to navigate complex digital public services — such as state scholarship portals, welfare schemes, and university admissions. These pages are often walls of bureaucratic text with buried deadlines, complex fee structures, and required document checklists.

**Sleepwalker** turns any website into an intuitive, voice-controlled assistive experience:
1. **Always-On Floating Pill:** A compact, non-intrusive floating pill (Wispr Flow style) rests at the bottom-right of every webpage. Draggable anywhere, with position remembered across reloads.
2. **Signature "Explain This Page":** In one click or voice command (*"Explain this page"* or *"पेज समझाओ"*), Sleepwalker extracts the essential purpose, fees, dates, and required documents into a clear summary under 120 words.
3. **Full-Screen Prism Glow:** While listening or preparing, screen borders illuminate in a soft, transparent prism glow (cyan, violet, pink, amber) that blooms bright when the answer is ready, leaving the central 72% of the page completely transparent and readable.
4. **Sentence-by-Sentence Speech & Highlighting:** Speech synthesis highlights each sentence as it speaks aloud in English (`en-IN`) or Hindi (`hi-IN`).
5. **Strict DOM Privacy:** User passwords, text fields, and form inputs are **100% stripped and excluded**. Credentials are never read aloud or transmitted.
6. **Hallucination Validator:** Numbers, amounts, and dates in the model's answer are strictly cross-referenced against the page text. Hallucinated sentences are automatically dropped.

---

## 📁 Repository Structure

```text
sleepwalker/
├── manifest.json       # Manifest V3 configuration (activeTab, scripting, storage, offscreen)
├── background.js       # Service worker: toggle, script injection, LLM cascade & offscreen manager
├── content.js          # In-page bootstrap, Alt+S & Alt+Z Hold-to-Talk key listener
├── widget.js           # Shadow DOM UI controller, settings, and module orchestrator
├── widget.css          # Encapsulated styles: pill, glow animations, bubble, high contrast
├── pill.js             # Wispr-Flow floating round pill, equalizer bars, companion bubble
├── glow.js             # Full-screen prism glow edge overlay with center cutout mask
├── explain.js          # Safe extraction, Devanagari normalizer, hallucination validator, offline fallback
├── llm.js              # Cascade engine: Cache -> Cloud Gemini Proxy -> Local Ollama -> Offline Fallback
├── voice.js            # Web Speech API recognition, silence auto-commit, en-IN & hi-IN parser
├── reader.js           # Content extractor, table parser, sentence-by-sentence SpeechSynthesis
├── outline.js          # H1-H4 heading extractor and fuzzy section matcher
├── mic-setup.html      # Microphone onboarding, live Web Audio volume visualizer & hardware report
├── mic-setup.js        # getUserMedia, Web Audio AnalyserNode meter, and speech test
├── offscreen.html      # Offscreen audio document host
├── offscreen.js        # Chromium offscreen speech recognition evaluator & reporter
├── test-sample.html    # Benchmark portal (articles, fees table, documents, login form with password)
├── icons/              # 16px, 48px, 128px high-DPI extension icons
└── proxy/              # Serverless proxy folder (keeps API keys off the client)
    ├── worker.js       # Cloudflare Worker implementation (CORS, rate limiting, Gemini Flash)
    ├── api/explain.js  # Vercel Serverless Function alternative
    ├── .env.example    # Environment variable template
    └── README.md       # Proxy deployment and security guide
```

---

## 🚀 Step-by-Step Installation Guide

Sleepwalker is built entirely with plain vanilla JavaScript, HTML, and CSS. It requires **no build step, no bundler, no npm install, and no TypeScript compilation**. It installs directly in Chrome in under 30 seconds.

### Step 1: Clone or Download the Repository
Open a terminal and clone the repository:
```bash
git clone https://github.com/vatsalpro/sleep.git
```
*(Alternatively, download the ZIP archive from GitHub and extract it to a local folder, e.g. `D:\sleep`).*

### Step 2: Open Extensions in Google Chrome
1. Open **Google Chrome** (or Microsoft Edge, Brave, or any Chromium-based browser).
2. In the address bar, type:
   ```text
   chrome://extensions
   ```
   and press Enter.

### Step 3: Enable Developer Mode
1. In the top-right corner of the Extensions page, locate the toggle labeled **"Developer mode"**.
2. Turn this toggle **ON**. Additional toolbar buttons (*Load unpacked*, *Pack extension*, *Update*) will appear on the top-left.

### Step 4: Load the Unpacked Extension
1. Click the **"Load unpacked"** button in the top-left corner.
2. In the folder picker dialog, select the cloned `sleep` folder (e.g. `D:\sleep`).
3. Click **Select Folder**.
4. The extension card **"Sleepwalker - Voice Web Assistant"** will appear immediately with its full feature set active.

### Step 5: Pin the Extension to Chrome Toolbar
1. Click the **puzzle piece icon** (Extensions menu) in Chrome's top toolbar.
2. Find **Sleepwalker** in the list and click the **Pin** icon next to it so the moon icon (`🌙`) is always visible.

### Step 6: (Optional) Allow Access to File URLs
If you plan to test Sleepwalker on local HTML files (like `file:///D:/sleep/test-sample.html`):
1. On the `chrome://extensions` page, click **Details** on the Sleepwalker card.
2. Scroll down and toggle ON **"Allow access to file URLs"**.
*(Note: On regular websites like Wikipedia or any live portal, Sleepwalker works immediately without this step).*

---

## 🤖 Detailed AI Model Setup Guide

Sleepwalker supports **three flexible AI execution modes**. You can use 100% private local offline models, high-speed cloud models via a secure proxy, or the built-in offline extractive fallback with zero setup.

```mermaid
flowchart TD
    A["User triggers 'Explain This Page'"] --> B["Safe DOM Extraction (Filters Out Form Inputs & Passwords)"]
    B --> C{"Check In-Memory Cache (URL + Section + Lang)"}
    C -- Hit --> D["Return Cached Answer (0ms)"]
    C -- Miss --> E{"Local-Only Mode Enabled?"}
    E -- No --> F["Cloud Gemini Flash via Proxy (8s Timeout)"]
    F -- Success --> G["Hallucination Validator"]
    F -- Failure / Cooldown --> H["Local Ollama llama3.2:3b (8s Timeout)"]
    E -- Yes --> H
    H -- Success --> G
    H -- Offline / Timeout --> I["Offline Extractive Basic Summary (Regex & Headings)"]
    G -- Valid --> J["Ready Bloom Animation & Sentence-by-Sentence Speech"]
    G -- Hallucinated Number --> I
    I --> J
```

---

### Option A: Local Ollama (Recommended — 100% Private, Free & Offline)

Running Ollama on your computer allows Sleepwalker to generate explanations locally. **No data ever leaves your computer, zero internet connection is required for AI, and there are no API costs or quotas.**

#### Step 1: Install Ollama
Download and install Ollama for your operating system:
- **Windows / macOS / Linux:** Download from **[https://ollama.com/download](https://ollama.com/download)**.
- Follow the standard installer instructions.

#### Step 2: Download the Recommended Model
Open your terminal (PowerShell, Command Prompt, or Terminal) and run:
```bash
ollama run llama3.2:3b
```
> **Tip:** The `llama3.2:3b` model (~2 GB) is optimized for high-speed edge reasoning and fits easily into system RAM or laptop GPUs. You can also use other models such as `qwen2.5:3b`, `qwen2.5:1.5b`, or `phi3:mini`.

#### Step 3: Verify Ollama is Running
Ensure the Ollama background service is active by testing its HTTP endpoint in your terminal or browser:
```bash
curl http://localhost:11434/api/tags
```
If you see JSON containing `"models": [...]`, Ollama is running and ready.

#### Step 4: Configure Sleepwalker
1. Open any webpage and press <kbd>Alt+S</kbd> (or click the toolbar icon) to slide open the Sleepwalker side panel.
2. Scroll to the **⚙️ AI & Prism Glow Settings** card.
3. Check the box for **"Local-Only Mode (Skip Cloud Gemini; use Ollama/Offline)"**.
4. Confirm the fields:
   - **Local Ollama URL:** `http://localhost:11434`
   - **Ollama Model Name:** `llama3.2:3b`
5. Click **"🔌 Test Connection"**.
   - Chrome will show a one-time runtime permission dialog requesting access to `http://localhost:11434/*`. Click **Allow**.
   - You will see a green badge: `✅ Local Ollama online! Available models: llama3.2:3b`.
6. Click **"💾 Save Settings"**.

---

### Option B: Cloud Gemini via Serverless Proxy (Fastest & Highest Quality)

For ultra-low latency and superior Hindi fluency, Sleepwalker can call Google's **Gemini 1.5 Flash** model. 

> [!IMPORTANT]
> **Why use a Serverless Proxy?**
> Chrome extension packages are distributed as plain JavaScript. Hardcoding an API key inside client extension files exposes it to anyone who inspects DevTools or unzips the CRX. The proxy securely holds the `GEMINI_API_KEY` on your own serverless worker, rate-limits requests per IP, restricts CORS to Chrome extensions, and never logs user page text.

#### Step 1: Get a Free Gemini API Key
1. Visit **[Google AI Studio](https://aistudio.google.com/app/apikey)**.
2. Sign in with your Google account.
3. Click **"Create API Key"**.
4. Copy your generated key (`AIzaSy...`).
*(The Google AI Studio free tier provides 15 requests per minute with no credit card required).*

#### Step 2: Deploy the Serverless Proxy

##### Sub-option 1: Deploy to Cloudflare Workers (Recommended — Free 100k requests/day)
1. Open a terminal and navigate to the `proxy` folder:
   ```bash
   cd proxy
   ```
2. Install the Cloudflare CLI tool (Wrangler):
   ```bash
   npm install -g wrangler
   ```
3. Log in to your Cloudflare account:
   ```bash
   wrangler login
   ```
4. Set your Gemini API key as a secure secret:
   ```bash
   wrangler secret put GEMINI_API_KEY
   ```
   *(Paste your API key when prompted).*
5. Deploy the worker:
   ```bash
   wrangler deploy worker.js --name sleepwalker-proxy
   ```
6. Wrangler will output your live URL, for example:
   ```text
   https://sleepwalker-proxy.<your-subdomain>.workers.dev
   ```

##### Sub-option 2: Deploy to Vercel (Alternative)
1. Navigate to the `proxy` folder:
   ```bash
   cd proxy
   ```
2. Deploy using Vercel CLI:
   ```bash
   npm install -g vercel
   vercel
   ```
3. In the Vercel Project Settings dashboard, add Environment Variables:
   - `GEMINI_API_KEY`: Your Gemini API key
   - `GEMINI_MODEL`: `gemini-1.5-flash-latest`
4. Your endpoint will be `https://<your-project>.vercel.app/api/explain`.

#### Step 3: Connect the Proxy to Sleepwalker
1. Open the Sleepwalker side panel with <kbd>Alt+S</kbd>.
2. In **⚙️ AI & Prism Glow Settings**, paste your proxy URL into the **Cloud Serverless Proxy URL** field.
3. Click **"🔌 Test Connection"** and allow the permission prompt.
4. Click **"💾 Save Settings"**.

---

### Option C: Built-in Offline Extractive Fallback (Zero Setup Required)

If neither Ollama nor a Cloud Proxy is configured, Sleepwalker **works immediately out of the box with zero external dependencies**:
- Analyzes document semantic roots (`<main>`, `<article>`, `[role=main]`).
- Extracts headings and identifies document structure.
- Applies localized regex patterns to detect:
  - **Fees & Amounts:** e.g. `1,200 INR`, `₹50`, `$50 USD`
  - **Deadlines & Dates:** e.g. `January 15, 2027`, `31 October`
  - **Required Documents:** e.g. `domicile certificate`, `marks sheets`, `income certificate`
- Formulates a concise 3–5 sentence explanation in English or Hindi in **0 milliseconds with zero network requests**.
- The output is clearly marked with: `[Source: basic summary]`.

---

## ⌨️ How to Use Every Feature

### 1. The Floating Pill (Wispr-Flow Style)
- **Always Visible:** The round 56px pill rests at the bottom-right of every webpage.
- **Draggable:** Click and drag the pill to any position on the screen. Its coordinates are saved per-site.
- **Equalizer Sound Bars:** Animated equalizer waves pulse green when speaking and amber when preparing.
- **Companion Bubble:** Click the pill to open the bubble. From here, you can:
  - Type a command and press Enter.
  - Click **"✨ Explain"** to analyze the page.
  - Click **"⏹️ Stop"** to cancel reading or processing.
  - Click **"Expand"** to slide open the full side panel.

### 2. Click-to-Talk & Hold-to-Talk
- **Click-to-Talk:** Click the microphone icon on the pill or panel. Speak your command. If you pause for 2 seconds, Sleepwalker auto-commits and executes your command.
- **Hold-to-Talk (<kbd>Alt+Z</kbd>):** Hold down <kbd>Alt+Z</kbd> on any webpage, speak your command, and release the keys to execute instantly.
- **Emergency Stop (<kbd>Escape</kbd>):** Press <kbd>Escape</kbd> at any time to immediately abort speech synthesis, stop voice recognition, and turn off prism glow.

### 3. Full Side Panel (<kbd>Alt+S</kbd>)
Press <kbd>Alt+S</kbd> or click the toolbar icon to access:
- **Language Switch:** Toggle between **🇮🇳 EN** (English - India) and **🇮🇳 HI** (Hindi - India).
- **Text Size Controls:** Switch between 18px, 22px, and 26px for high-legibility viewing.
- **Speech Speed Controls:** Adjust reading speed (0.8x slow, 1.0x normal, 1.2x fast).
- **Outline View:** Click **"📑 Outline"** to extract all headings with 1-click read buttons.
- **Microphone Setup (`🎙️ Setup`):** Launches `mic-setup.html` with real-time Web Audio input meters.

---

## 🗣️ Bilingual Voice & Typed Commands Reference

| Action | English Spoken / Typed Command | Hindi Spoken / Typed Command |
| :--- | :--- | :--- |
| **Explain Page** | `"Explain this page"`, `"Explain"` | `"पेज समझाओ"`, `"सरल भाषा में बताओ"` |
| **Explain Section** | `"Explain the fees section"` | `"फीस सेक्शन समझाओ"` |
| **Read Entire Page** | `"Read this page"`, `"Start reading"` | `"यह पेज पढ़ो"`, `"सुनाओ"` |
| **Read Specific Section** | `"Read the eligibility section"` | `"योग्यता पढ़ो"` |
| **Show Headings** | `"Outline"`, `"Show headings"` | `"आउटलाइन"`, `"रूपरेखा"` |
| **Pause Speech** | `"Pause"`, `"Wait"` | `"रोको"`, `"पॉज़"` |
| **Resume Speech** | `"Resume"`, `"Continue"` | `"आगे पढ़ो"`, `"जारी रखो"` |
| **Stop Speech** | `"Stop"`, `"Cancel"` | `"बंद करो"`, `"शांत"` |
| **Repeat From Start** | `"Read it again"`, `"Repeat"` | `"फिर से पढ़ो"`, `"दोहराओ"` |
| **Help & Instructions** | `"Help"`, `"Commands"` | `"मदद"`, `"सहायता"` |

---

## 🔒 Privacy & Security Guarantees

1. **Zero Form or Password Capture:** Sleepwalker's Safe Text Extractor explicitly drops all `input`, `textarea`, `select`, `button`, and `input[type="password"]` elements. Form values and credentials are never read aloud, highlighted, or transmitted.
2. **Encapsulated Shadow DOM:** All extension UI elements, animations, and styles reside inside an isolated Shadow DOM (`#sleepwalker-host`), preventing CSS conflicts and ensuring no page layout shifts.
3. **No External Scripts:** Does not load any remote JavaScript or analytics scripts. Strictly complies with Chrome Manifest V3 security boundaries.
4. **Transient Zero-Log Proxy:** The `/proxy` serverless code acts solely as a stateless pass-through to the Gemini API and never writes user page text to disks or database logs.

---

## ⚖️ Open Source & License

Developed for the **CodeQuest National Tech Hackathon 2026**. Distributed under the open-source MIT License.
