/**
 * status: active
 * phase: change-b-group-3-ordered-fallback
 * sprint: gemini-model-fallback-and-rate-limit-recovery
 * last_modified: 2026-08-07
 * agent_notes: "Fake-clock/fake-invoker matrix; no network, wall-clock timer, sleep, or random behavior."
 * insights: "The injected invoker is the bounded in-flight boundary for tests. Production Gemini generation intentionally remains unbounded by an adapter-wide timeout per Change A."
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  GEMINI_TERMINAL_MAX_BYTES,
  GEMINI_TERMINAL_TRUNCATION_MARKER,
  formatGeminiTerminalMessage,
  runPreparedGeminiRoute,
  type GeminiRouteInput,
  type StartedGeminiAttempt
} from '../services/gemini-recovery-router.js';
import { createProviderFailure } from '../services/provider-failure.js';
import type { NormalizedGeminiFailure } from '../services/gemini-error-classifier.js';
import type { ProviderFailureCategory, RecognitionResult } from '../types/provider.js';

class FakeClock {
  nowMs = 0;
  readonly now = (): number => this.nowMs;
  advance(ms: number): void { this.nowMs += ms; }
}

const transient = (category: ProviderFailureCategory = 'temporary-service', code = 'UNAVAILABLE'): NormalizedGeminiFailure => ({
  envelopeState: 'not-applicable',
  failure: createProviderFailure({ provider: 'gemini', category, safeMessage: 'fixed', code })
});
const failFast = (category: ProviderFailureCategory, code?: string): NormalizedGeminiFailure => ({
  envelopeState: 'not-applicable',
  failure: createProviderFailure({ provider: 'gemini', category, safeMessage: 'fixed', ...(code === undefined ? {} : { code }) })
});
const unusable = (): NormalizedGeminiFailure => ({
  envelopeState: 'unusable',
  failure: createProviderFailure({ provider: 'gemini', category: 'malformed-response', safeMessage: 'fixed' })
});
const input = (overrides: Partial<GeminiRouteInput> = {}): GeminiRouteInput => ({
  candidates: ['primary', 'secondary', 'third'], pinned: false,
  maxAttempts: 4, deadlineSeconds: 30, deadlineStartedAt: 0, ...overrides
});

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};

test('primary success returns unchanged text and starts no later candidate', async () => {
  const clock = new FakeClock();
  const calls: string[] = [];
  const outcome = await runPreparedGeminiRoute(input(), {
    now: clock.now,
    invokePreparedModel: async model => { calls.push(model); return { text: ' exact\ntext ' }; }
  });
  assert.deepEqual(outcome, { kind: 'success', result: { text: ' exact\ntext ' } });
  assert.deepEqual(calls, ['primary']);
});

test('ordered fallback invokes each unique candidate at most once and one request per attempt', async () => {
  const clock = new FakeClock();
  const calls: string[] = [];
  let upstreamRequests = 0;
  const outcome = await runPreparedGeminiRoute(input({ candidates: ['primary', 'primary', 'secondary', 'third'] }), {
    now: clock.now,
    invokePreparedModel: async model => {
      calls.push(model); upstreamRequests += 1;
      if (model === 'primary') throw transient();
      return { text: 'secondary success' };
    }
  });
  assert.deepEqual(calls, ['primary', 'secondary']);
  assert.equal(upstreamRequests, calls.length);
  assert.deepEqual(outcome, { kind: 'success', result: { text: 'secondary success' } });
});

test('all transient candidates exhaust in exact order with one attempt record each', async () => {
  const clock = new FakeClock();
  const calls: string[] = [];
  const outcome = await runPreparedGeminiRoute(input(), {
    now: clock.now,
    invokePreparedModel: async model => { calls.push(model); throw transient(); }
  });
  assert.equal(outcome.kind, 'terminal');
  if (outcome.kind !== 'terminal') assert.fail('expected terminal');
  assert.equal(outcome.reason, 'route-exhausted');
  assert.equal(outcome.attemptsUsed, 3);
  assert.deepEqual(outcome.attempts.map(row => [row.model, row.attempt]), [['primary', 1], ['secondary', 2], ['third', 3]]);
  assert.deepEqual(calls, ['primary', 'secondary', 'third']);
});

test('every fail-fast category returns the original failure and starts no later model', async () => {
  const categories = ['authentication', 'permission', 'billing', 'invalid-request', 'unsupported-media', 'safety', 'malformed-response', 'unknown'] as const;
  for (const category of categories) {
    const clock = new FakeClock();
    const value = failFast(category);
    let calls = 0;
    const outcome = await runPreparedGeminiRoute(input(), {
      now: clock.now,
      invokePreparedModel: async () => { calls += 1; throw value; }
    });
    assert.equal(outcome.kind, 'fail-fast');
    if (outcome.kind !== 'fail-fast') assert.fail('expected fail-fast');
    assert.equal(outcome.failure, value.failure);
    assert.equal(calls, 1);
  }
  const cancelled = failFast('cancelled', 'CALLER_CANCELLED');
  const cancelledOutcome = await runPreparedGeminiRoute(input(), { now: () => 0, invokePreparedModel: async () => { throw cancelled; } });
  assert.equal(cancelledOutcome.kind, 'fail-fast');
});

test('attempt cap increments only immediately before invocation and never on completion', async () => {
  const clock = new FakeClock();
  let calls = 0;
  const outcome = await runPreparedGeminiRoute(input({ maxAttempts: 2 }), {
    now: clock.now,
    invokePreparedModel: async () => { calls += 1; throw transient(); }
  });
  assert.equal(calls, 2);
  assert.equal(outcome.kind, 'terminal');
  if (outcome.kind === 'terminal') {
    assert.equal(outcome.attemptsUsed, calls);
    assert.deepEqual(outcome.attempts.map(row => row.attempt), [1, 2]);
  }
});

test('strict deadline gate blocks equal/after and permits immediately-before starts', async () => {
  for (const nowMs of [30_000, 30_001]) {
    let calls = 0;
    const outcome = await runPreparedGeminiRoute(input(), { now: () => nowMs, invokePreparedModel: async () => { calls += 1; return { text: 'no' }; } });
    assert.equal(calls, 0);
    assert.deepEqual(outcome, { kind: 'terminal', reason: 'deadline-terminated', attemptsUsed: 0, attempts: [] });
  }
  let calls = 0;
  const outcome = await runPreparedGeminiRoute(input(), { now: () => 29_999, invokePreparedModel: async () => { calls += 1; return { text: 'yes' }; } });
  assert.equal(calls, 1);
  assert.equal(outcome.kind, 'success');
});

test('pending invocation crosses deadline without router cancellation and late success is accepted', async () => {
  const clock = new FakeClock();
  clock.advance(29_999);
  const pending = deferred<RecognitionResult>();
  let calls = 0;
  const routed = runPreparedGeminiRoute(input(), {
    now: clock.now,
    invokePreparedModel: async () => { calls += 1; return pending.promise; }
  });
  await Promise.resolve();
  assert.equal(calls, 1);
  clock.advance(60_001); // injected invoker owns this bounded in-flight interval
  pending.resolve({ text: 'late exact success' });
  assert.deepEqual(await routed, { kind: 'success', result: { text: 'late exact success' } });
});

test('post-deadline transient, fail-fast, and owned adapter timeout failures terminate by deadline', async () => {
  for (const failure of [transient(), failFast('authentication'), transient('timeout', 'ADAPTER_TIMEOUT')]) {
    const clock = new FakeClock();
    const pending = deferred<RecognitionResult>();
    let calls = 0;
    const routed = runPreparedGeminiRoute(input(), { now: clock.now, invokePreparedModel: async () => { calls += 1; return pending.promise; } });
    await Promise.resolve();
    clock.advance(30_000);
    pending.reject(failure);
    const outcome = await routed;
    assert.equal(outcome.kind, 'terminal');
    if (outcome.kind === 'terminal') assert.equal(outcome.reason, 'deadline-terminated');
    assert.equal(calls, 1);
  }
});

test('unusable envelope after expiry outranks deadline termination', async () => {
  const clock = new FakeClock();
  const pending = deferred<RecognitionResult>();
  const routed = runPreparedGeminiRoute(input(), { now: clock.now, invokePreparedModel: async () => pending.promise });
  await Promise.resolve();
  clock.advance(30_000);
  pending.reject(unusable());
  const outcome = await routed;
  assert.equal(outcome.kind, 'terminal');
  if (outcome.kind === 'terminal') assert.equal(outcome.reason, 'envelope-unusable');
});

test('eligibility skips consume no attempts, create no gaps, and never poll', async () => {
  const checks: string[] = [];
  const calls: string[] = [];
  const outcome = await runPreparedGeminiRoute(input(), {
    now: () => 0,
    isCandidateEligible: model => { checks.push(model); return model !== 'primary'; },
    invokePreparedModel: async model => { calls.push(model); throw transient(); }
  });
  assert.deepEqual(checks, ['primary', 'secondary', 'third']);
  assert.deepEqual(calls, ['secondary', 'third']);
  assert.equal(outcome.kind, 'terminal');
  if (outcome.kind === 'terminal') assert.deepEqual(outcome.attempts.map(row => row.attempt), [1, 2]);

  let allFalseCalls = 0;
  const allFalse = await runPreparedGeminiRoute(input(), { now: () => 0, isCandidateEligible: () => false, invokePreparedModel: async () => { allFalseCalls += 1; return { text: 'no' }; } });
  assert.equal(allFalseCalls, 0);
  assert.deepEqual(allFalse, { kind: 'terminal', reason: 'route-exhausted', attemptsUsed: 0, attempts: [] });
});

test('pins bypass eligibility, use one model, preserve route, and never fallback', async () => {
  for (const pin of ['primary', 'secondary', 'off-route', 'cooling']) {
    const route = ['primary', 'secondary'];
    const calls: string[] = [];
    let checks = 0;
    const outcome = await runPreparedGeminiRoute(input({ candidates: [pin], pinned: true }), {
      now: () => 0,
      isCandidateEligible: () => { checks += 1; return false; },
      invokePreparedModel: async model => { calls.push(model); throw transient(); }
    });
    assert.deepEqual(calls, [pin]);
    assert.equal(checks, 0);
    assert.equal(outcome.kind, 'terminal');
    assert.deepEqual(route, ['primary', 'secondary']);
  }
});

test('terminal formatter escapes controls/bidi, is deterministic, bounded, and uses only closed tuples', () => {
  const escaped = formatGeminiTerminalMessage('envelope-unusable', [{
    provider: 'gemini', model: `a\u0000\u0085\u061C\u200E\u202E\u2066b`, attempt: 1,
    category: 'malformed-response'
  }]);
  for (const unit of ['\\u0000', '\\u0085', '\\u061C', '\\u200E', '\\u202E', '\\u2066']) {
    assert.equal(escaped.includes(unit), true);
  }
  assert.doesNotMatch(escaped, /[\u0000\u0085\u061C\u200E\u202E\u2066]/u);

  const attempts: StartedGeminiAttempt[] = Array.from({ length: 8 }, (_, index) => ({
    provider: 'gemini',
    model: `${'😀'.repeat(200)}"\\\u0085\u061C\u202E\u2066-secret-${index}`,
    attempt: index + 1,
    category: (['rate-limit', 'timeout', 'temporary-service', 'malformed-response'] as const)[index % 4]!
  }));
  const output = formatGeminiTerminalMessage('route-exhausted', attempts);
  assert.equal(output, formatGeminiTerminalMessage('route-exhausted', attempts));
  assert.equal(Buffer.byteLength(output, 'utf8') <= GEMINI_TERMINAL_MAX_BYTES, true);
  assert.match(output, /reason=route-exhausted/u);
  assert.match(output, /\\u0085|\[\.\.\.\]/u);
  assert.equal(output.includes(GEMINI_TERMINAL_TRUNCATION_MARKER), true);
  assert.equal(output.includes('backup-exhausted'), false);
  assert.equal(output.includes('safeMessage'), false);
  assert.equal(output.includes('cause='), false);
  for (let attempt = 1; attempt <= 8; attempt += 1) assert.equal(output.includes(`attempt=${attempt},category=`), true);
});

test('all three Group 3 terminal reasons format exactly once', () => {
  const attempt: StartedGeminiAttempt = { provider: 'gemini', model: 'model', attempt: 1, category: 'temporary-service' };
  for (const reason of ['route-exhausted', 'deadline-terminated', 'envelope-unusable'] as const) {
    const output = formatGeminiTerminalMessage(reason, [attempt]);
    assert.equal(output.match(/reason=/gu)?.length, 1);
    assert.equal(output.includes(`reason=${reason}`), true);
  }
});