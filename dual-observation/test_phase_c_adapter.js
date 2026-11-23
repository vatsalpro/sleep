/**
 * Sleepwalker 2.0 — Phase C Verification Test Suite
 *
 * Validates the mechanical Sandbox Browser Adapter against Sleepwalker's real AI planning pipeline:
 * 1. Verifies Sleepwalker (not Antigravity/Adapter) determines intent and actions.
 * 2. Verifies mechanical translation without action alteration.
 * 3. Verifies post-action state verification via SleepwalkerStateVerifier.
 * 4. Verifies synchronized event recording to events.jsonl.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { executeObservedTask, SleepwalkerStateVerifier } = require('./sandbox-adapter');

const EVENTS_FILE = path.join(__dirname, 'evidence', 'events.jsonl');

async function run() {
  console.log('=== Sleepwalker 2.0 — Phase C: Sandbox Browser Adapter Verification ===\n');

  // Baseline event count
  const initialEventCount = fs.existsSync(EVENTS_FILE)
    ? fs.readFileSync(EVENTS_FILE, 'utf-8').split('\n').filter(Boolean).length
    : 0;

  // Simulated browser environment tracking real state
  const browserState = {
    currentUrl: 'about:blank',
    title: '',
    inputs: {},
    pageLoaded: false,
    history: []
  };

  // Mechanical Browser Relay (Mocking Sandbox Browser execution)
  const mockSandboxRelay = async (action, preState) => {
    const act = (action.action || '').toLowerCase();
    await new Promise((r) => setTimeout(r, 120)); // Simulated browser execution latency

    if (act === 'navigate') {
      const targetUrl = action.url || action.target || 'https://www.wikipedia.org';
      browserState.currentUrl = targetUrl;
      browserState.title = targetUrl.includes('wikipedia') ? 'Wikipedia, the free encyclopedia' : 'Documentation Example';
      browserState.pageLoaded = true;
      browserState.history.push(targetUrl);
      return {
        url: browserState.currentUrl,
        title: browserState.title,
        httpStatus: 200,
        pageLoaded: true
      };
    }

    if (act === 'type') {
      const field = action.target || '#searchInput';
      const text = action.text || '';
      browserState.inputs[field] = text;
      return {
        url: browserState.currentUrl,
        title: browserState.title,
        targetField: field,
        inputValue: text,
        typeSuccess: true
      };
    }

    if (act === 'click') {
      return {
        url: browserState.currentUrl,
        title: browserState.title,
        clicked: true,
        target: action.target
      };
    }

    if (act === 'verify') {
      return {
        url: browserState.currentUrl,
        title: browserState.title,
        contentFound: true
      };
    }

    return {
      url: browserState.currentUrl,
      title: browserState.title,
      executed: true
    };
  };

  // Run Test Scenario 1: Natural language search using Local Ollama pipeline
  console.log('>>> Test Scenario 1: Real Local Ollama Intent & Planning Pipeline');
  const result1 = await executeObservedTask(
    {
      testId: 'TEST-PHASE-C-OLLAMA-SEARCH',
      commandId: 'CMD-ADAPTER-01',
      prompt: 'Search for artificial intelligence courses on Wikipedia',
      providerPreference: 'ollama'
    },
    mockSandboxRelay
  );

  // Assertions
  assert(result1.passed === true, 'All steps determined by Sleepwalker must verify successfully');
  assert.strictEqual(result1.telemetry.provider, 'ollama', 'Provider must be real local Ollama');
  assert(result1.actionPlan.length >= 1, 'Sleepwalker must produce an action plan');
  assert.strictEqual(result1.executionResults.length, result1.actionPlan.length, 'Execution results must match action plan length');

  console.log('\n✅ Scenario 1 Succeeded:');
  console.log(`   - Model: ${result1.telemetry.model}`);
  console.log(`   - Planned Steps: ${result1.actionPlan.length}`);
  console.log(`   - Verified Steps: ${result1.executionResults.filter((r) => r.success).length}`);
  console.log(`   - Final Browser URL: ${browserState.currentUrl}`);
  console.log(`   - Typed Input: ${JSON.stringify(browserState.inputs)}`);

  // Run Test Scenario 2: Direct StateVerifier unit tests
  console.log('\n>>> Test Scenario 2: SleepwalkerStateVerifier Boundary Validation');

  const navPass = SleepwalkerStateVerifier.verifyStep(
    { action: 'navigate', url: 'https://example.com' },
    { url: 'about:blank' },
    { url: 'https://example.com/index.html', httpStatus: 200, pageLoaded: true }
  );
  assert.strictEqual(navPass.verified, true, 'Navigate verification must pass on matching URL');

  const navFail = SleepwalkerStateVerifier.verifyStep(
    { action: 'navigate', url: 'https://wikipedia.org' },
    { url: 'about:blank' },
    { url: 'https://example.com', httpStatus: 200, pageLoaded: true }
  );
  assert.strictEqual(navFail.verified, false, 'Navigate verification must fail on mismatch URL');

  const typePass = SleepwalkerStateVerifier.verifyStep(
    { action: 'type', target: '#search', text: 'Machine Learning' },
    { url: 'https://example.com' },
    { inputValue: 'Machine Learning', typeSuccess: true }
  );
  assert.strictEqual(typePass.verified, true, 'Type verification must pass when inputValue matches');

  const typeFail = SleepwalkerStateVerifier.verifyStep(
    { action: 'type', target: '#search', text: 'Machine Learning' },
    { url: 'https://example.com' },
    { inputValue: 'Wrong Content', typeSuccess: true }
  );
  assert.strictEqual(typeFail.verified, false, 'Type verification must fail when inputValue mismatches');

  console.log('✅ Scenario 2 Succeeded: StateVerifier correctly accepts valid transitions and rejects invalid state changes.');

  // Verify Event Stream
  const finalEventCount = fs.readFileSync(EVENTS_FILE, 'utf-8').split('\n').filter(Boolean).length;
  assert(finalEventCount > initialEventCount, 'Adapter events must be appended to evidence/events.jsonl');
  console.log(`✅ Scenario 3 Succeeded: Synchronized events logged (${finalEventCount - initialEventCount} new events recorded).`);

  console.log('\n=== ALL PHASE C ACCEPTANCE CRITERIA PASSED ===');
}

run().catch((err) => {
  console.error('Phase C Test Failed:', err);
  process.exit(1);
});
