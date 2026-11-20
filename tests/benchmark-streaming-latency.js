/**
 * Sleepwalker Phase 4 — Empirical Latency Benchmark: Baseline REST vs Streaming / Live WebSocket
 *
 * Measures actual wall-clock performance against real configured Local Ollama and Gemini APIs:
 * 1. Short conversational query (Gemini REST vs SSE vs Live WS cold vs Live WS reused session; Ollama REST vs NDJSON stream)
 * 2. Longer multi-sentence page explanation (REST blocking wait vs Streaming TTFT & first-sentence / first spoken chunk)
 * 3. Repeated / cached requests (SleepwalkerAiCommManager EXPLAIN_CACHE stream latency)
 * 4. Interrupted conversations / barge-in cancellation latency (abort mid-stream + supersede with new request)
 * 5. Live WebSocket reconnection + session resumption latency (close + resume handle)
 *
 * Run with: node D:\sleep\tests\benchmark-streaming-latency.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const llm = require(path.join(ROOT, 'llm.js'));
const liveMod = require(path.join(ROOT, 'gemini-live.js'));
const aiCommMod = require(path.join(ROOT, 'ai-comm.js'));

function loadDotEnvMap() {
  const out = {};
  const envPath = path.join(ROOT, '.env');
  if (!fs.existsSync(envPath)) return out;
  const parsed = llm.parseDotEnv(fs.readFileSync(envPath, 'utf8'));
  Object.assign(out, parsed || {});
  return out;
}

function setupMockStorage(env) {
  const local = {
    sleepwalker_gemini_api_key: env.GEMINI_API_KEY || '',
    sleepwalker_gemini_model: env.GEMINI_MODEL || 'gemini-2.5-flash-lite',
    sleepwalker_ollama_url: env.OLLAMA_URL || 'http://localhost:11434',
    sleepwalker_ollama_model: env.OLLAMA_MODEL || 'llama3.2:3b',
    sleepwalker_proxy_url: env.CLOUD_PROXY_URL || '',
    sleepwalker_local_only: false,
    sleepwalker_live_ws: false
  };
  global.chrome = {
    runtime: { lastError: null },
    storage: {
      local: {
        get(keys, cb) {
          const out = {};
          const list = Array.isArray(keys) ? keys : Object.keys(keys || {});
          for (const k of list) out[k] = local[k];
          cb(out);
        },
        set(obj, cb) {
          Object.assign(local, obj || {});
          if (cb) cb();
        }
      }
    }
  };
  return local;
}

async function runOllamaRestOnce(ollamaUrl, model, prompt) {
  const t0 = Date.now();
  const base = ollamaUrl.replace(/\/+$/, '');
  const res = await fetch(`${base}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      prompt,
      format: 'json',
      stream: false,
      options: { num_ctx: 1536, temperature: 0.2, num_predict: 180 }
    })
  });
  const json = await res.json();
  const totalMs = Date.now() - t0;
  return { ok: res.ok, totalMs, ttftMs: totalMs, firstSpokenMs: totalMs, chars: (json.response || '').length };
}

async function runGeminiRestOnce(apiKey, model, prompt) {
  const t0 = Date.now();
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      system_instruction: { parts: [{ text: 'Return ONLY valid JSON: {"answer":"plain concise text","highlightSections":[]}.' }] },
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.15, maxOutputTokens: 240, responseMimeType: 'application/json' }
    })
  });
  const json = await res.json();
  const totalMs = Date.now() - t0;
  const txt = json?.candidates?.[0]?.content?.parts?.[0]?.text || '';
  return { ok: res.ok, status: res.status, totalMs, ttftMs: totalMs, firstSpokenMs: totalMs, chars: txt.length };
}

async function main() {
  console.log('=== Sleepwalker Phase 4 — Live Empirical Latency & Streaming Benchmark ===\n');
  const env = loadDotEnvMap();
  const localStore = setupMockStorage(env);
  llm.resetLlmStateForTests();

  const digestSampleShort = 'URL: https://example.org/china\nTitle: China Overview\nSection Summary:\nChina is in East Asia with a population exceeding 1.4 billion people. Beijing is the national capital and Shanghai is its financial hub.';
  const digestSampleLong = `${digestSampleShort} ` +
    'China borders fourteen countries across diverse terrain including the Gobi Desert, Tibetan Plateau, and Yangtze River basin. ' +
    'Tourists visiting China normally apply for a Tourist Visa (L Visa) with a passport valid for six months, confirmed round-trip flights, and hotel reservations. ' +
    'Standard visa processing generally takes four business days at consulates or visa application centers.';

  const makePayload = (suffix, digest, query, mode = 'qa') => ({
    urlClean: `https://example.org/${suffix}`,
    pageTextHash: `bench_${suffix}_${Date.now()}`,
    mode,
    level: 'standard',
    target: '',
    query,
    lang: 'en-IN',
    digestPrompt: digest,
    chunksPrompt: digest
  });

  // ---------------------------------------------------------------------------
  // 1. Ollama Baseline REST (stream: false) vs Streaming NDJSON (stream: true)
  // ---------------------------------------------------------------------------
  console.log('--- 1. Local Ollama: Baseline REST vs Streaming NDJSON ---');
  let ollamaOnline = false;
  try {
    const check = await llm.checkOllamaModelStatus(localStore.sleepwalker_ollama_url, localStore.sleepwalker_ollama_model);
    ollamaOnline = Boolean(check.available && check.modelInstalled);
    console.log(`   Status: available=${check.available}, model=${localStore.sleepwalker_ollama_model}, installed=${check.modelInstalled}, tagsMs=${check.latencyMs}ms`);
  } catch (e) {
    console.log('   Ollama check failed:', e.message);
  }

  if (ollamaOnline) {
    const shortPayload = makePayload('ollama_short', digestSampleShort, 'What is the capital of China?');
    const longPayload = makePayload('ollama_long', digestSampleLong, 'Summarize China geography, capital, and tourist visa steps in 4 clear sentences.', 'summary');
    const shortBuilt = llm.buildExplainPromptsForClient(shortPayload, 'ollama');
    const longBuilt = llm.buildExplainPromptsForClient(longPayload, 'ollama');

    // Warm up model weights cleanly once
    await llm.callLocalOllamaExplainStream(localStore.sleepwalker_ollama_url, localStore.sleepwalker_ollama_model, shortPayload);

    const oShortRest = await runOllamaRestOnce(localStore.sleepwalker_ollama_url, localStore.sleepwalker_ollama_model, `${shortBuilt.systemPrompt}\n\n${shortBuilt.userPrompt}\n\nJSON:`);
    const mgr = new aiCommMod.SleepwalkerAiCommManager({ llm, liveMod });

    localStore.sleepwalker_local_only = true;
    localStore.sleepwalker_gemini_api_key = '';
    const oShortEvs = [];
    const oShortStream = await mgr.streamExplain({ sessionId: 'bench_ol', payload: makePayload('ol_s2', digestSampleShort, 'What is the capital of China?') }, (e) => oShortEvs.push({ t: e.type, at: Date.now() }));

    const oLongRest = await runOllamaRestOnce(localStore.sleepwalker_ollama_url, localStore.sleepwalker_ollama_model, `${longBuilt.systemPrompt}\n\n${longBuilt.userPrompt}\n\nJSON:`);
    const oLongStream = await mgr.streamExplain({ sessionId: 'bench_ol', payload: makePayload('ol_l2', digestSampleLong, 'Summarize China geography, capital, and tourist visa steps in 4 clear sentences.', 'summary') });

    console.log('   Ollama Short Q&A:');
    console.log(`     Baseline REST  (stream:false): total=${oShortRest.totalMs}ms | firstSpoken=${oShortRest.firstSpokenMs}ms`);
    console.log(`     Upgraded NDJSON (stream:true): ttft=${oShortStream.metrics.ttftMs}ms | firstSpokenChunk=${oShortStream.metrics.firstSentenceMs}ms | total=${oShortStream.metrics.totalMs}ms`);
    console.log('   Ollama Longer Summary:');
    console.log(`     Baseline REST  (stream:false): total=${oLongRest.totalMs}ms | firstSpoken=${oLongRest.firstSpokenMs}ms`);
    console.log(`     Upgraded NDJSON (stream:true): ttft=${oLongStream.metrics.ttftMs}ms | firstSpokenChunk=${oLongStream.metrics.firstSentenceMs}ms | total=${oLongStream.metrics.totalMs}ms`);

    // 4a. Ollama Cancellation mid-stream + supersede benchmark
    const cancelPrompt = makePayload('ol_cancel', digestSampleLong, 'Explain every detail about China visas, history, geography, airports, and trade in 5 sentences.', 'summary');
    let firstTokenSeenAt = 0;
    let cancelledEarly = null;
    const pSlow = mgr.streamExplain({ sessionId: 'bench_cancel_ol', payload: cancelPrompt }, (ev) => {
      if (ev.type === 'delta' && !firstTokenSeenAt) {
        firstTokenSeenAt = Date.now();
        cancelledEarly = mgr.cancelSession('bench_cancel_ol', 'bench_barge_in');
      }
    });
    const cancelRes = await pSlow;
    console.log('   Ollama Mid-Stream Cancellation:');
    console.log(`     Cancelled cleanly=${cancelRes.status === 'cancelled'} | cancelLatency=${cancelledEarly ? cancelledEarly.cancelLatencyMs : -1}ms | stoppedTotal=${cancelRes.metrics.totalMs}ms`);
  } else {
    console.log('   SKIP: Ollama unavailable.');
  }

  // Restore Gemini creds for cloud benchmarks
  localStore.sleepwalker_local_only = false;
  localStore.sleepwalker_gemini_api_key = env.GEMINI_API_KEY || '';
  const gModel = localStore.sleepwalker_gemini_model || 'gemini-flash-lite-latest';

  // ---------------------------------------------------------------------------
  // 2. Gemini REST vs SSE Streaming vs Cache Hit vs Ephemeral Auth + Live WS
  // ---------------------------------------------------------------------------
  console.log('\n--- 2. Gemini Cloud: REST vs SSE Streaming vs Persistent Live WS ---');
  if (localStore.sleepwalker_gemini_api_key) {
    llm.resetLlmStateForTests();
    const gShortRest = await runGeminiRestOnce(localStore.sleepwalker_gemini_api_key, gModel, `${digestSampleShort}\nQuestion: What is the capital and financial hub of China?`);
    const gLongRest = await runGeminiRestOnce(localStore.sleepwalker_gemini_api_key, gModel, `${digestSampleLong}\nSummarize China geography, capital, and tourist visa steps in 4 clear sentences.`);

    const mgrCloud = new aiCommMod.SleepwalkerAiCommManager({ llm, liveMod });
    const gShortPayload = makePayload('gem_short', digestSampleShort, 'What is the capital and financial hub of China?');
    const gLongPayload = makePayload('gem_long', digestSampleLong, 'Summarize China geography, capital, and tourist visa steps in 4 clear sentences.', 'summary');

    const gShortSse = await mgrCloud.streamExplain({ sessionId: 'bench_gem', payload: gShortPayload });
    const gLongSse = await mgrCloud.streamExplain({ sessionId: 'bench_gem', payload: gLongPayload });

    // Repeated / Cached request
    const gCached = await mgrCloud.streamExplain({ sessionId: 'bench_gem', payload: gShortPayload });

    console.log(`   Gemini Short Q&A (${gModel}):`);
    console.log(`     Baseline REST : ok=${gShortRest.ok} status=${gShortRest.status} chars=${gShortRest.chars} total=${gShortRest.totalMs}ms | firstSpoken=${gShortRest.firstSpokenMs}ms`);
    console.log(`     Upgraded SSE  : status=${gShortSse.status} transport=${gShortSse.transport} source=${gShortSse.source} ttft=${gShortSse.metrics.ttftMs}ms | firstSpokenChunk=${gShortSse.metrics.firstSentenceMs}ms | total=${gShortSse.metrics.totalMs}ms`);
    console.log(`   Gemini Long Explanation (${gModel}):`);
    console.log(`     Baseline REST : ok=${gLongRest.ok} status=${gLongRest.status} chars=${gLongRest.chars} total=${gLongRest.totalMs}ms | firstSpoken=${gLongRest.firstSpokenMs}ms`);
    console.log(`     Upgraded SSE  : status=${gLongSse.status} transport=${gLongSse.transport} source=${gLongSse.source} ttft=${gLongSse.metrics.ttftMs}ms | firstSpokenChunk=${gLongSse.metrics.firstSentenceMs}ms | total=${gLongSse.metrics.totalMs}ms`);
    console.log(`   Repeated / Cached Request: transport=${gCached.transport} | ttft=${gCached.metrics.ttftMs}ms | total=${gCached.metrics.totalMs}ms`);

    // 3. Gemini Live WebSocket: Ephemeral Token Mint + Cold Connect + Reused Persistent Turn + Reconnect/Resume + Barge-In Interrupt
    console.log('\n--- 3. Gemini Live WebSocket Lifecycle & Reconnection ---');
    const tok = await liveMod.mintEphemeralLiveToken(localStore.sleepwalker_gemini_api_key, { uses: 2 });
    console.log(`   Ephemeral auth_tokens mint: ok=${tok.ok}, latency=${tok.latencyMs}ms`);

    const liveSess = new liveMod.SleepwalkerGeminiLiveSession({
      apiKey: localStore.sleepwalker_gemini_api_key,
      model: 'models/gemini-3.1-flash-live-preview',
      systemInstruction: 'Reply concisely in one or two short sentences.'
    });
    try {
      const turn1 = await liveSess.sendTurn('Remember the topic "China Visa". Reply with one short sentence confirming.');
      const turn2 = await liveSess.sendTurn('What topic did I just ask you to remember? Reply in one short sentence.');

      console.log(`   Live Turn 1 (cold connect + setup): connMs=${turn1.metrics.connMs}ms | setupMs=${turn1.metrics.setupMs}ms | ttftMs=${turn1.metrics.ttftMs}ms | firstAudioMs=${turn1.metrics.firstAudioMs}ms | totalMs=${turn1.metrics.totalMs}ms | hasResume=${Boolean(turn1.resumptionHandle)}`);
      console.log(`   Live Turn 2 (persistent reused WS): reused=${turn2.metrics.reusedSession} | connMs=${turn2.metrics.connMs}ms | setupMs=${turn2.metrics.setupMs}ms | ttftMs=${turn2.metrics.ttftMs}ms | totalMs=${turn2.metrics.totalMs}ms | reply="${turn2.text.slice(0, 80)}"`);

      // Simulate unexpected socket drop -> measure reconnect + session resumption latency
      liveSess._teardownSocket(1012, 'simulated_restart');
      const rec0 = Date.now();
      const recInfo = await liveSess.ensureConnected();
      const recWallMs = Date.now() - rec0;
      const turn3 = await liveSess.sendTurn('Are you still tracking our China Visa topic? Say yes concisely.');
      console.log(`   Live Reconnect + Session Resumption: reconnectWallMs=${recWallMs}ms (conn=${recInfo.connMs}ms, setup=${recInfo.setupMs}ms) | turn3TotalMs=${turn3.metrics.totalMs}ms | reply="${turn3.text.slice(0, 80)}"`);

      // Live turn interruption latency measurement
      let liveInterruptInfo = null;
      const turn4Promise = liveSess.sendTurn('Explain the complete history and geography of Beijing in 5 sentences.', {
        onDelta: () => {
          if (!liveInterruptInfo) {
            liveInterruptInfo = liveSess.interrupt('benchmark_barge_in');
          }
        }
      });
      const turn4Res = await turn4Promise;
      console.log(`   Live Barge-In Interrupt Latency: interrupted=${turn4Res.interrupted} | cancelLatencyMs=${liveInterruptInfo ? liveInterruptInfo.cancelLatencyMs : -1}ms | stoppedTotalMs=${turn4Res.metrics.totalMs}ms`);
    } catch (liveErr) {
      console.log('   Live WS Benchmark error:', liveErr.message);
    } finally {
      liveSess.close('benchmark_done');
    }
  } else {
    console.log('   SKIP: GEMINI_API_KEY not configured in .env');
  }
}

main().catch((err) => {
  console.error('Benchmark error:', err);
  process.exit(1);
});
