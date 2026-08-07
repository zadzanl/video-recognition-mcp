/**
 * status: active
 * phase: change-b-groups-4-5-recovery
 * sprint: gemini-model-fallback-and-rate-limit-recovery
 * last_modified: 2026-08-07
 * agent_notes: "Deterministic bounded cooldown tests using only caller-supplied timestamps."
 * insights: "Exact expiry is eligible; refresh receives a new sequence; overflow evicts by expiry then insertion order without background work."
 */

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { createProviderModelCooldownStore } from '../services/provider-cooldown-store.js';

test('cooldown is active before expiry and lazily removed at the exact boundary', () => {
  const store = createProviderModelCooldownStore();
  store.recordTransientFailure('gemini', 'model', 100, 50);
  assert.equal(store.isCooling('gemini', 'model', 149), true);
  assert.equal(store.isCooling('gemini', 'model', 150), false);
  assert.equal(store.isCooling('gemini', 'model', 151), false);
});

test('zero duration removes an existing entry and tuple keys cannot collide', () => {
  const store = createProviderModelCooldownStore();
  store.recordTransientFailure('a', 'b\u0000c', 0, 100);
  store.recordTransientFailure('a\u0000b', 'c', 0, 100);
  store.recordTransientFailure('a', 'b\u0000c', 1, 0);
  assert.equal(store.isCooling('a', 'b\u0000c', 1), false);
  assert.equal(store.isCooling('a\u0000b', 'c', 1), true);
});

test('refresh replaces expiry and receives a later insertion sequence', () => {
  const store = createProviderModelCooldownStore(2);
  store.recordTransientFailure('p', 'old', 0, 100);
  store.recordTransientFailure('p', 'other', 0, 100);
  store.recordTransientFailure('p', 'old', 10, 90);
  store.recordTransientFailure('p', 'new', 10, 90);
  assert.equal(store.isCooling('p', 'other', 10), false);
  assert.equal(store.isCooling('p', 'old', 10), true);
  assert.equal(store.isCooling('p', 'new', 10), true);
});

test('overflow from 64 to 65 evicts earliest expiry and equal-expiry insertion ties', () => {
  const store = createProviderModelCooldownStore();
  for (let index = 0; index < 64; index += 1) {
    store.recordTransientFailure('gemini', `model-${index}`, 0, index === 10 ? 50 : 100);
  }
  store.recordTransientFailure('gemini', 'model-64', 0, 100);
  assert.equal(store.isCooling('gemini', 'model-10', 0), false);
  assert.equal(store.isCooling('gemini', 'model-0', 0), true);

  const tied = createProviderModelCooldownStore(2);
  tied.recordTransientFailure('p', 'first', 0, 100);
  tied.recordTransientFailure('p', 'second', 0, 100);
  tied.recordTransientFailure('p', 'third', 0, 100);
  assert.equal(tied.isCooling('p', 'first', 0), false);
  assert.equal(tied.isCooling('p', 'second', 0), true);
  assert.equal(tied.isCooling('p', 'third', 0), true);
});

test('multiple expired entries are cleaned before insertion and adversarial keys stay bounded', () => {
  const store = createProviderModelCooldownStore();
  for (let index = 0; index < 64; index += 1) {
    store.recordTransientFailure(`provider-${index % 3}`, `off-route-${index}`, 0, 10);
  }
  store.recordTransientFailure('backup', 'configured', 10, 100);
  for (let index = 0; index < 64; index += 1) {
    assert.equal(store.isCooling(`provider-${index % 3}`, `off-route-${index}`, 10), false);
  }
  assert.equal(store.isCooling('backup', 'configured', 10), true);
});

test('source has no ambient clock, timer, polling, filesystem, or network work', async () => {
  const source = await readFile(
    path.resolve(process.cwd(), 'src/services/provider-cooldown-store.ts'),
    'utf8'
  );
  for (const forbidden of [
    /Date\.now/u, /setTimeout/u, /setInterval/u, /sleep/iu, /poll/iu,
    /node:fs/u, /fetch\s*\(/u, /Math\.random/u
  ]) assert.doesNotMatch(source, forbidden);
});
