'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

// Minimal global/chrome harness routing SLEEPWALKER_EMBED_REQUEST to real llm.js handleEmbedRequest
const storageLocal = {};
const storageSession = {};
let llmModule = null;

global.window = global;
global.self = global;
if (!global.navigator) {
  Object.defineProperty(global, 'navigator', { value: { language: 'en-IN' }, configurable: true });
}
global.location = { href: 'https://example.org/', hostname: 'example.org', pathname: '/' };

global.chrome = {
  runtime: {
    lastError: null,
    sendMessage(msg, cb) {
      if (msg && msg.type === 'SLEEPWALKER_EMBED_REQUEST' && llmModule) {
        llmModule.handleEmbedRequest(msg).then((res) => {
          if (typeof cb === 'function') cb(res);
        }).catch((err) => {
          if (typeof cb === 'function') cb({ status: 'error', error: String(err), embedding: null });
        });
        return true;
      }
      if (typeof cb === 'function') cb({ status: 'ok' });
      return false;
    }
  },
  storage: {
    local: {
      get(keys, cb) {
        const out = {};
        if (typeof keys === 'string') out[keys] = storageLocal[keys];
        else if (Array.isArray(keys)) keys.forEach((k) => { out[k] = storageLocal[k]; });
        else if (keys && typeof keys === 'object') Object.keys(keys).forEach((k) => { out[k] = storageLocal[k] !== undefined ? storageLocal[k] : keys[k]; });
        else Object.assign(out, storageLocal);
        cb(out);
      },
      set(obj, cb) {
        Object.assign(storageLocal, obj || {});
        if (typeof cb === 'function') cb();
      }
    },
    session: {
      get(keys, cb) {
        const out = {};
        if (typeof keys === 'string') out[keys] = storageSession[keys];
        else if (Array.isArray(keys)) keys.forEach((k) => { out[k] = storageSession[k]; });
        else Object.assign(out, storageSession);
        cb(out);
      },
      set(obj, cb) {
        Object.assign(storageSession, obj || {});
        if (typeof cb === 'function') cb();
      }
    }
  }
};

require(path.join(__dirname, '..', 'diagnostics.js'));
llmModule = require(path.join(__dirname, '..', 'llm.js'));
require(path.join(__dirname, '..', 'memory.js'));

const SleepwalkerMemory = global.window.SleepwalkerMemory;

async function main() {
  console.log('=== Sleepwalker Phase 5 Empirical Embedding Benchmark ===\n');

  // 1. Direct Ollama /api/embed check via llm.js
  llmModule.resetLlmStateForTests();
  const coldStart = Date.now();
  const probe1 = await llmModule.handleEmbedRequest({ text: 'University admission requirements in Munich Germany' });
  const coldMs = Date.now() - coldStart;

  const warmStart = Date.now();
  const probe2 = await llmModule.handleEmbedRequest({ text: 'Computer science engineering master degree abroad' });
  const warmMs = Date.now() - warmStart;

  const cacheStart = Date.now();
  const probeCache = await llmModule.handleEmbedRequest({ text: 'University admission requirements in Munich Germany' });
  const cacheMs = Date.now() - cacheStart;

  console.log('1. Direct Ollama Embedding Latency & Cache:');
  console.log(`   - Cold request (includes /api/tags check): status=${probe1.status}, model=${probe1.model || 'none'}, dim=${probe1.dim || 0}, wallMs=${coldMs}, handlerMs=${probe1.latencyMs}`);
  console.log(`   - Warm request (60s availability cached):  status=${probe2.status}, model=${probe2.model || 'none'}, dim=${probe2.dim || 0}, wallMs=${warmMs}, handlerMs=${probe2.latencyMs}`);
  console.log(`   - L1 cache hit:                            status=${probeCache.status}, cached=${Boolean(probeCache.cached)}, wallMs=${cacheMs}`);

  if (probe1.status !== 'ok' || !Array.isArray(probe1.embedding)) {
    console.log('\nSKIP/WARN: Live Ollama nomic-embed-text not reachable; cannot run neural vs fallback live comparison.');
    process.exit(1);
  }
  assert.strictEqual(probe1.dim, 768, 'nomic-embed-text should return 768 dimensions');
  assert.strictEqual(probeCache.cached, true, 'Second identical call should hit L1 cache');

  // 2. Populate realistic multi-topic activity corpus
  const mem = new SleepwalkerMemory();
  await mem.loadState();

  const corpus = [
    {
      user_command: 'Find universities in Germany.',
      intent: 'OFF_PAGE_RESEARCH',
      topic: 'Germany',
      entities: ['Germany', 'TUM', 'LMU'],
      result: 'Higher education study options in Munich and Aachen, technical institutions.',
      related_task_id: 'task_germany'
    },
    {
      user_command: 'I am planning a trip to China.',
      intent: 'OFF_PAGE_RESEARCH',
      topic: 'China',
      entities: ['China'],
      result: 'Travel itinerary, flight booking and entry visa requirements for Beijing and Shanghai.',
      related_task_id: 'task_china'
    },
    {
      user_command: 'Find the best laptops.',
      intent: 'OFF_PAGE_RESEARCH',
      topic: 'Laptops',
      entities: ['Laptops', 'ThinkPad', 'MacBook'],
      result: 'Portable workstations and notebooks for software engineering.',
      related_task_id: 'task_laptops'
    },
    {
      user_command: 'Search for quick tomato pasta recipe.',
      intent: 'SEARCH',
      topic: 'recipe',
      entities: ['pasta'],
      result: 'Italian dinner cooking guide with basil and garlic sauce.',
      related_task_id: 'task_recipe'
    },
    {
      user_command: 'Check campus library hours.',
      intent: 'OFF_PAGE_RESEARCH',
      topic: 'library',
      entities: ['library'],
      result: 'Academic reading room schedules and textbook borrowing rules.',
      related_task_id: 'task_library'
    },
    {
      user_command: 'Explain JavaScript async await.',
      intent: 'EXPLAIN_PAGE',
      topic: 'javascript',
      entities: ['javascript'],
      result: 'Promises, event loop concurrency and asynchronous control flow in web browsers.',
      related_task_id: 'task_js'
    }
  ];

  for (const entry of corpus) {
    await mem.recordActivity(entry);
  }
  // Wait for / ensure neural vectors matching each activity's exact embedKey are stored
  for (const act of mem.state.activities) {
    const text = `${act.user_command} ${act.topic} ${(act.entities || []).join(' ')} ${act.page_title || ''} ${act.result}`.trim().slice(0, 400);
    await mem.getQueryNeuralEmbeddingAsync(text, 3000);
  }
  await mem.saveState();

  // Measure storage footprint
  const serializedLocal = JSON.stringify(storageLocal);
  const memJsonBytes = Buffer.byteLength(JSON.stringify(storageLocal['sleepwalker_persistent_memory_v1'] || {}), 'utf8');
  const neuralJsonBytes = Buffer.byteLength(JSON.stringify(storageLocal['sleepwalker_embed_vectors_v1'] || {}), 'utf8');
  console.log('\n2. Storage Overhead Comparison (6 stored activities, separated buckets):');
  console.log(`   - Main memory state (64-d vectors + tasks + activities): ${memJsonBytes} bytes`);
  console.log(`   - Separated neural vectors (768-d nomic-embed-text):     ${neuralJsonBytes} bytes`);
  console.log(`   - Total chrome.storage.local footprint:                  ${Buffer.byteLength(serializedLocal, 'utf8')} bytes`);
  assert.ok(neuralJsonBytes > 0, 'Neural vectors should be stored separately in sleepwalker_embed_vectors_v1');

  // 3. Retrieval accuracy benchmark: zero-lexical-overlap semantic paraphrases + conversational queries
  const queries = [
    { q: 'How do I cross border control into Beijing?', expectedTopic: 'China', note: 'zero lexical overlap' },
    { q: 'Engineering tuition in Bavaria or Munich', expectedTopic: 'Germany', note: 'semantic paraphrase' },
    { q: 'Which computer has great battery for writing code?', expectedTopic: 'Laptops', note: 'zero lexical overlap' },
    { q: 'Making Italian dinner with marinara sauce', expectedTopic: 'recipe', note: 'semantic paraphrase' },
    { q: 'Where can students borrow textbooks quietly?', expectedTopic: 'library', note: 'semantic paraphrase' },
    { q: 'Non-blocking promises and event loop in Node', expectedTopic: 'javascript', note: 'semantic paraphrase' },
    { q: 'What passport entry permit do I need for that trip?', expectedTopic: 'China', note: 'paraphrase + trip signal' },
    { q: 'Compare German university application rules', expectedTopic: 'Germany', note: 'lexical + semantic' }
  ];

  // Clear activeTopic bias to test pure content retrieval fairness
  mem.state.currentTopic = '';
  mem.state.currentEntities = { countries: [], companies: [], colleges: [], products: [], all: [] };
  mem.state.activeTask = null;

  let detHits = 0;
  let neuralHits = 0;
  let detPureSimHits = 0;
  let neuralPureSimHits = 0;
  let detTotalUs = 0;
  let neuralColdTotalMs = 0;
  let neuralWarmTotalUs = 0;

  console.log('\n3. Retrieval Comparison: deterministic-64d vs nomic-embed-text (768-d):');
  console.log('   Query                                                | Expect    | Det-64d (Sim/Top1)         | Neural-768d (Sim/Top1)       | Notes');
  console.log('   -----------------------------------------------------+-----------+----------------------------+------------------------------+---------------------');

  for (const item of queries) {
    // Deterministic fallback only (bypass neural map for comparison)
    const tDet0 = process.hrtime.bigint();
    const detRes = mem.retrieveRelevantMemories(item.q, { topK: 6, queryNeuralVec: null });
    detTotalUs += Number(process.hrtime.bigint() - tDet0) / 1000;

    // Force-ignore act neural vectors to inspect pure 64d similarity vs pure 768d similarity
    const detQueryVec = mem.computeDeterministicEmbedding(item.q);
    const detPureScored = mem.state.activities.map((a) => ({
      topic: a.topic,
      sim: mem.cosineSimilarity(detQueryVec, a.embedding)
    })).sort((a, b) => b.sim - a.sim);
    if (detPureScored[0].topic === item.expectedTopic) detPureSimHits++;

    // Full Async Neural Retrieval (768-d Ollama)
    const tN0 = Date.now();
    const neuralRes = await mem.retrieveRelevantMemoriesAsync(item.q, { topK: 6, timeoutMs: 2500 });
    neuralColdTotalMs += (Date.now() - tN0);

    // Warm/cached query timing after embedding is in _neuralVectors
    const tW0 = process.hrtime.bigint();
    const warmRes = mem.retrieveRelevantMemories(item.q, { topK: 6 });
    neuralWarmTotalUs += Number(process.hrtime.bigint() - tW0) / 1000;

    const qNeuralEntry = await mem.getQueryNeuralEmbeddingAsync(item.q, 2500);
    const neuralPureScored = mem.state.activities.map((a) => ({
      topic: a.topic,
      sim: mem.cosineSimilarity(qNeuralEntry.vec, mem._neuralVectors.get(a.embedKey))
    })).sort((a, b) => b.sim - a.sim);
    if (neuralPureScored[0].topic === item.expectedTopic) neuralPureSimHits++;

    if (detRes[0] && detRes[0].activity.topic === item.expectedTopic) detHits++;
    if (neuralRes[0] && neuralRes[0].activity.topic === item.expectedTopic) neuralHits++;
    else {
      console.log(`     [MISS Hybrid-Neural] q="${item.q}" top2=`, neuralRes.slice(0, 2).map((r) => `${r.activity.topic}:${r.score}(sim=${r.cosineSimilarity},rec=${r.recencyWeight},ent=${r.entityOverlap},top=${r.topicMatch})`));
    }

    const pad = (s, n) => String(s).slice(0, n).padEnd(n, ' ');
    console.log(
      `   ${pad(item.q, 52)} | ${pad(item.expectedTopic, 9)} | ${pad(`${detPureScored[0].sim.toFixed(3)} ${detPureScored[0].topic}`, 26)} | ${pad(`${neuralPureScored[0].sim.toFixed(3)} ${neuralPureScored[0].topic}`, 28)} | ${item.note}`
    );
  }

  const avgDetMs = (detTotalUs / queries.length / 1000).toFixed(3);
  const avgNeuralFirstMs = (neuralColdTotalMs / queries.length).toFixed(1);
  const avgNeuralCachedMs = (neuralWarmTotalUs / queries.length / 1000).toFixed(3);

  console.log('\n4. Summary Metrics:');
  console.log(`   - Pure Cosine Top-1 Accuracy (Deterministic 64-d): ${detPureSimHits}/${queries.length} (${Math.round((detPureSimHits / queries.length) * 100)}%)`);
  console.log(`   - Pure Cosine Top-1 Accuracy (nomic-embed-text):   ${neuralPureSimHits}/${queries.length} (${Math.round((neuralPureSimHits / queries.length) * 100)}%)`);
  console.log(`   - Hybrid Multi-Signal Top-1 (Deterministic):       ${detHits}/${queries.length}`);
  console.log(`   - Hybrid Multi-Signal Top-1 (Neural 768-d):        ${neuralHits}/${queries.length}`);
  console.log(`   - Avg Query Latency (Deterministic 64-d):          ${avgDetMs} ms`);
  console.log(`   - Avg Query Latency (Uncached nomic-embed-text):   ${avgNeuralFirstMs} ms`);
  console.log(`   - Avg Query Latency (Cached 768-d in memory.js):   ${avgNeuralCachedMs} ms`);

  assert.ok(neuralPureSimHits >= detPureSimHits, 'Real nomic-embed-text 768-d should equal or outperform deterministic-64d cosine accuracy');
  assert.strictEqual(neuralHits, queries.length, 'Hybrid multi-signal + nomic-embed-text should achieve 100% Top-1 across all 8 benchmark queries');
  console.log('\nPASS  Phase 5 Embedding Benchmark verified.');
}

main().catch((err) => {
  console.error('BENCHMARK FAILED:', err);
  process.exit(1);
});
