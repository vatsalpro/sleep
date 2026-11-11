# Sleepwalker - Serverless AI Proxy

This directory contains the serverless proxy code for the **Sleepwalker** Manifest V3 Chrome extension (CodeQuest National Tech Hackathon 2026).

---

## 🔒 Why a Serverless Proxy?

1. **Zero Client Secret Leaks:** Chrome extension packages are distributed as plain JavaScript files. Hardcoding an API key inside the extension means anyone inspecting DevTools or unpacking the CRX can steal your quota. The proxy keeps the `GEMINI_API_KEY` securely on the server.
2. **CORS & Origin Restriction:** The proxy permits requests originating from Chrome extensions while enforcing rate limiting (max 30 requests/minute/IP).
3. **Strict Zero-Logging Privacy:** The proxy **never** logs page text or user queries to disk or cloud logging services. It acts solely as a stateless, transient bridge to Google Gemini.

---

## ⚡ Option A: Deploy to Cloudflare Workers (Recommended - Free Tier)

Cloudflare Workers provide 100,000 requests/day for free with 0ms cold starts.

### Steps:
1. **Install Wrangler (Cloudflare CLI):**
   ```bash
   npm install -g wrangler
   ```
2. **Login to Cloudflare:**
   ```bash
   wrangler login
   ```
3. **Configure your Gemini Secret:**
   Get a free API key at [Google AI Studio](https://aistudio.google.com/app/apikey).
   ```bash
   cd proxy
   wrangler secret put GEMINI_API_KEY
   # Paste your Gemini API key when prompted
   ```
4. **Deploy:**
   ```bash
   wrangler deploy worker.js --name sleepwalker-proxy
   ```
5. You will receive a URL like:
   `https://sleepwalker-proxy.<your-subdomain>.workers.dev`

---

## ▲ Option B: Deploy to Vercel (Alternative)

1. **Install Vercel CLI:**
   ```bash
   npm install -g vercel
   ```
2. **Deploy from proxy folder:**
   ```bash
   cd proxy
   vercel
   ```
3. **Set Environment Variables in Vercel Dashboard:**
   - `GEMINI_API_KEY` = your Gemini key
   - `GEMINI_MODEL` = `gemini-1.5-flash-latest`
4. Your endpoint will be:
   `https://<your-project>.vercel.app/api/explain`

---

## 🔌 Connecting to Sleepwalker Extension

Once deployed, provide the proxy URL to Sleepwalker:

### Method 1: Using the Sleepwalker Settings Panel
1. Open Sleepwalker by pressing <kbd>Alt+S</kbd>.
2. Scroll to the **AI & Proxy Settings** card.
3. Paste your proxy URL into the **Cloud Proxy URL** field.
4. Click **Save Settings**.

### Method 2: Via Chrome DevTools Console
Open DevTools on any page and execute:
```javascript
chrome.storage.local.set({ sleepwalker_proxy_url: "https://sleepwalker-proxy.<your-subdomain>.workers.dev" });
```

---

## 🛡️ Fallback Architecture & Local Mode

- **No Proxy Configured?** Sleepwalker checks for a local **Ollama** server running at `http://localhost:11434` with model `llama3.2:3b`.
- **No Ollama Running?** Sleepwalker instantly falls back to its **Offline Extractive Summarizer** (`source: basic summary`) which analyzes document headings, fees, deadlines, and required documents locally with **0ms latency and 0 network requests**.
