# Sleepwalker 2.0 — AI Browser Copilot

## Chrome Extension Project (`sleepwalker-extension/`) & Demo Video

- **Standalone Chrome Extension Folder**: [`sleepwalker-extension/`](sleepwalker-extension/) *(clean 60-file Manifest V3 Chrome Extension — load unpacked in `chrome://extensions`)*
- **Demo Video**: [Watch Sleepwalker Demo on Google Drive](https://drive.google.com/file/d/1Ue-pk6MQmsGaCiGdGQhCr2D5Xg0gSd7T/view?usp=sharing)

---

Sleepwalker 2.0 is a standalone Windows AI desktop copilot with **browser intelligence** as its primary strength. It combines a persistent, light-theme floating WPF widget, a single unified task orchestrator, dual AI providers (**Local Ollama** + **Google Gemini API**), genuine CDP browser interaction with AXTree/`backendNodeId` grounding and Shadow DOM support, and Windows desktop automation (**Win32 SendInput + UI Automation + Ghost MIT sidecar**).

---

## Architecture Overview

- **Floating Desktop Widget** (`desktop/Sleepwalker.Desktop/`): Persistent WPF floating orb, expandable command panel, live execution HUD, voice input & TTS (`System.Speech`), global hotkeys (`Alt+S` summon, `Alt+Shift+X` Emergency Stop), and AI/privacy settings.
- **Unified Runtime & Single Orchestrator** (`desktop/runtime/runtime-server.mjs` → loads canonical `unified-orchestrator.js` & `unified-task-contract.js`): One task lifecycle, one central context manager (`desktop/runtime/context-manager.mjs`), consequential-action confirmation gate (`/confirm`), cancellation, Emergency Stop, and safe resume.
- **Unified AI Provider Router** (`desktop/runtime/ai-provider-router.mjs`):
  - **Local Ollama** (`desktop/runtime/ollama-service.mjs`): Loopback-only (`127.0.0.1:11434`) with approved models `qwen2.5:1.5b`, `llama3.2:3b`, `qwen3-vl:2b`, `nomic-embed-text:latest`.
  - **Google Gemini API** (`desktop/runtime/gemini-service.mjs`): Current official REST API (`v1beta`) with `gemini-flash-latest`, `gemini-3.8-flash`, `gemini-3.1-flash-lite` + dynamic `/v1beta/models` discovery. API key stored strictly in `desktop/config/.gemini-key` (`0o600`) or `GEMINI_API_KEY`.
  - **4 Provider Modes**: `auto` (default), `local_only` (zero silent cloud fallback), `gemini_only`, `manual`. Cloud context upload is gated behind explicit user privacy opt-in (`allowCloudContextUpload`).
- **Browser Engine** (`desktop/browser/cdp-page-controller.mjs` + `ax-tree-grounding.mjs` + `world-model.js` + `Stagehand 3.7.4`):
  - Hierarchical & Shadow DOM discovery (`world-model.js`)
  - Browser Use-ported CDP `Accessibility.getFullAXTree` + `backendNodeId` grounding + `*` change-marker diffing + same-origin iframe mutation probe
  - Ghost-ported fire-and-forget `cdpMoveFast` + `Emulation.setFocusEmulationEnabled(true)`
  - Genuine CDP mouse, keyboard, wheel, and slider drag
- **Windows Desktop Backends**:
  - **Sleepwalker Native Companion** (`sleepwalker-native/bin/Release/net8.0-windows/sleepwalker-native.exe`): .NET 8 Win32 `SendInput`, UI Automation, and `SafetyController`.
  - **Ghost MIT Desktop Sidecar** (`desktop/runtime/ghost-desktop-sidecar.mjs` → `desktop/runtime/engines/ghost/ghost-mcp.exe`): STA COM UIA window/element discovery and WinRT OCR (`GHOST_FOCUS_LOCK=off`, `GHOST_FOCUS_POLICY=prefer_background`).
- **Document & Image Understanding** (`desktop/runtime/document-parser.mjs`): PDF, DOCX, XLSX, PPTX, TXT, CSV, code files, and PNG/JPG/WEBP/GIF/BMP images.

See [docs/OPEN_SOURCE_DECISIONS.md](docs/OPEN_SOURCE_DECISIONS.md) for the full open-source reuse and rejection rationale.

---

## Quick Start & Launch

### Prerequisites
- Windows 10/11 (x64)
- Node.js v18+
- .NET 8 SDK (to build `desktop/Sleepwalker.Desktop.sln` and `sleepwalker-native`)
- Local Ollama (`ollama serve`) and/or a Google Gemini API key

### 1. Pull Approved Local Ollama Models (Recommended)
```powershell
ollama pull qwen2.5:1.5b
ollama pull llama3.2:3b
ollama pull qwen3-vl:2b
ollama pull nomic-embed-text:latest
```

### 2. Build Desktop Binaries (Release)
```powershell
dotnet build D:\sleep\desktop\Sleepwalker.Desktop.sln -c Release
```

### 3. Launch Sleepwalker 2.0
Double-click `Launch-Sleepwalker.bat` or run:
```powershell
powershell -ExecutionPolicy Bypass -File D:\sleep\start-sleepwalker.ps1
```
*(Add `-ExtensionMode` to also launch the Chrome extension Stagehand bridge on port `4892`.)*

### 4. Configure Google Gemini API (Optional)
- Open **Settings → AI** from the floating widget (or send `POST /ai/config` with `{ "geminiApiKey": "...", "mode": "auto", "allowCloudContextUpload": true }`), OR set `$env:GEMINI_API_KEY`.
- The key is stored only in `desktop/config/.gemini-key` and is never written to `settings.json`, `ai-provider.json`, logs, or webpage scripts.
