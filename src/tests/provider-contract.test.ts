/**
 * status: active
 * phase: checkpoint-3-provider-contract
 * sprint: provider-foundation-first-sprint
 * last_modified: 2026-08-02
 * agent_notes: "Credential-free type/failure/default-ownership checks."
 * insights: "Provider failures remain Error instances while retained causes stay internal."
 */

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { createProviderFailure } from '../services/provider-failure.js';
import type {
  ProviderFailureCategory,
  RecognitionProvider,
  RecognitionResult
} from '../types/provider.js';

const repositoryRoot = process.cwd();

const allCategories: readonly ProviderFailureCategory[] = [
  'configuration',
  'authentication',
  'permission',
  'billing',
  'invalid-request',
  'unsupported-media',
  'safety',
  'rate-limit',
  'timeout',
  'temporary-service',
  'network',
  'cancelled',
  'malformed-response',
  'unknown'
];

const compileTimeProvider: RecognitionProvider = {
  recognize: async (_request, _options): Promise<RecognitionResult> => ({ text: 'ok' })
};

test('canonical contract remains success-only and includes all failure categories', async () => {
  const result = await compileTimeProvider.recognize({
    filepath: 'fixture.png',
    prompt: 'describe',
    mediaKind: 'image'
  });

  assert.deepEqual(result, { text: 'ok' });
  assert.deepEqual(allCategories, [
    'configuration', 'authentication', 'permission', 'billing', 'invalid-request',
    'unsupported-media', 'safety', 'rate-limit', 'timeout', 'temporary-service',
    'network', 'cancelled', 'malformed-response', 'unknown'
  ]);

  const source = await readFile(resolve(repositoryRoot, 'src/types/provider.ts'), 'utf8');
  const resultBlock = source.match(/export interface RecognitionResult \{[\s\S]*?\n\}/u)?.[0] ?? '';
  assert.match(resultBlock, /text: string;/u);
  assert.doesNotMatch(resultBlock, /isError|usage|info|synthesizeText/u);
});

test('provider failure is Error-compatible with a non-enumerable cause', () => {
  const cause = { secret: 'upstream-sensitive-value' };
  const failure = createProviderFailure({
    provider: 'gemini',
    category: 'unknown',
    safeMessage: 'Provider request failed.',
    status: 503,
    code: 'SAFE_CODE',
    retryAfterMs: 1000,
    cause
  });

  assert.equal(failure instanceof Error, true);
  assert.equal(failure.message, 'Provider request failed.');
  assert.equal(failure.cause, cause);
  assert.equal(Object.getOwnPropertyDescriptor(failure, 'cause')?.enumerable, false);
  assert.equal(Object.keys(failure).includes('cause'), false);
  assert.equal(Object.hasOwn({ ...failure }, 'cause'), false);
  assert.equal(JSON.stringify(failure).includes('cause'), false);
  assert.equal(JSON.stringify(failure).includes('upstream-sensitive-value'), false);
});

test('schema is sole prompt default and tools contain no prompt or model fallback', async () => {
  const typeSource = await readFile(resolve(repositoryRoot, 'src/types/index.ts'), 'utf8');
  assert.equal((typeSource.match(/\.default\('Describe this content'\)/gu) ?? []).length, 1);
  assert.doesNotMatch(typeSource, /modelname:[^\n]*\.default\(/u);

  for (const filename of ['image-recognition.ts', 'audio-recognition.ts', 'video-recognition.ts']) {
    const source = await readFile(resolve(repositoryRoot, `src/tools/${filename}`), 'utf8');
    assert.doesNotMatch(source, /Describe this (?:image|audio|video)/u);
    assert.doesNotMatch(source, /args\.(?:prompt|modelname)\s*(?:\|\||\?\?)/u);
    assert.match(source, /processFile\(file, args\.prompt, args\.modelname\)/u);
  }
});
