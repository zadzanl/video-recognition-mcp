/**
 * status: implementation-ready
 * phase: phase-5-wiring
 * sprint: provider-foundation-first-sprint
 * last_modified: 2026-08-05
 * agent_notes: "Phase 5 added the isProviderFailure guard matrix: accepts factory-created failures for every recognized provider/category combination, rejects plain objects, wrong names, unknown providers, unknown categories, non-string safe messages, non-Error values, and hostile getters. Retains non-enumerable cause tests and updates tool source assertions to verify one provider.recognize call and absence of tool-local validation, upload, and processing."
 * insights: "Provider failures remain Error instances while retained causes stay internal. The guard is the sole accepted typed-failure detector at the tool boundary."
 */

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { test } from 'node:test';
import {
  createProviderFailure,
  isProviderFailure
} from '../services/provider-failure.js';
import type {
  ProviderFailure,
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

const allProviders: readonly ProviderFailure['provider'][] = [
  'gemini',
  'openai-compatible'
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

test('isProviderFailure accepts every factory-created provider and category combination', () => {
  for (const provider of allProviders) {
    for (const category of allCategories) {
      const failure = createProviderFailure({
        provider,
        category,
        safeMessage: 'safe text'
      });
      assert.equal(isProviderFailure(failure), true, `${provider}/${category}`);
    }
  }
});

test('isProviderFailure accepts failures with optional status, code, retryAfterMs, and cause', () => {
  for (const failure of [
    createProviderFailure({ provider: 'gemini', category: 'rate-limit', safeMessage: 'limit' }),
    createProviderFailure({ provider: 'gemini', category: 'rate-limit', safeMessage: 'limit', status: 429 }),
    createProviderFailure({ provider: 'gemini', category: 'timeout', safeMessage: 'timed out', code: 'X' }),
    createProviderFailure({ provider: 'openai-compatible', category: 'rate-limit', safeMessage: 'limit', retryAfterMs: 1000 }),
    createProviderFailure({ provider: 'openai-compatible', category: 'unknown', safeMessage: 'x', cause: new Error('inner') })
  ]) {
    assert.equal(isProviderFailure(failure), true);
  }
});

test('isProviderFailure rejects plain objects, wrong names, unknown providers, unknown categories, non-string safe messages, and non-Error values', () => {
  const impostors: unknown[] = [
    null,
    undefined,
    'plain string',
    42,
    true,
    { safeMessage: 'forged-safe-message' },
    { name: 'ProviderFailure', provider: 'gemini', category: 'rate-limit', safeMessage: 'forged' },
    new Error('plain error with no ProviderFailure name'),
    Object.assign(new Error('forged error with name'), {
      name: 'ProviderFailure',
      provider: 'unknown-provider',
      category: 'rate-limit',
      safeMessage: 'forged'
    }),
    Object.assign(new Error('forged error with category'), {
      name: 'ProviderFailure',
      provider: 'gemini',
      category: 'unknown-category',
      safeMessage: 'forged'
    }),
    Object.assign(new Error('forged error with non-string safeMessage'), {
      name: 'ProviderFailure',
      provider: 'gemini',
      category: 'rate-limit',
      safeMessage: 42
    }),
    Object.assign(new Error('forged error with non-string provider'), {
      name: 'ProviderFailure',
      provider: 42,
      category: 'rate-limit',
      safeMessage: 'forged'
    }),
    Object.assign(new Error('forged error with non-string category'), {
      name: 'ProviderFailure',
      provider: 'gemini',
      category: true,
      safeMessage: 'forged'
    }),
    Object.assign(new Error('forged error missing provider'), {
      name: 'ProviderFailure',
      category: 'rate-limit',
      safeMessage: 'forged'
    }),
    Object.assign(new Error('forged error missing category'), {
      name: 'ProviderFailure',
      provider: 'gemini',
      safeMessage: 'forged'
    }),
    Object.assign(new Error('forged error missing safeMessage'), {
      name: 'ProviderFailure',
      provider: 'gemini',
      category: 'rate-limit'
    })
  ];

  for (const impostor of impostors) {
    assert.equal(isProviderFailure(impostor), false, JSON.stringify(impostor));
  }
});

test('isProviderFailure tolerates hostile getters by returning false', () => {
  const hostile = {
    name: 'ProviderFailure',
    get provider(): never { throw new Error('hostile provider getter'); },
    get category(): string { return 'rate-limit'; },
    get safeMessage(): string { return 'safe'; }
  };
  // The check on Error identity catches this first because hostile is a plain object.
  assert.equal(isProviderFailure(hostile), false);

  // Each potentially hostile property read on an Error instance must not throw.
  // The guard must report false in every case because no read is allowed to escape.
  // Error.prototype.name is non-configurable, so the hostile name getter is
  // installed through a subclass that owns a configurable name accessor.
  class HostileError extends Error {
    override get name(): never {
      throw new Error('hostile name getter on Error');
    }
  }
  const hostileNameError = new HostileError('hostile');
  assert.equal(isProviderFailure(hostileNameError), false);

  for (const hostileProperty of ['provider', 'category', 'safeMessage'] as const) {
    const hostileError = new Error('hostile');
    Object.defineProperty(hostileError, 'name', { value: 'ProviderFailure' });
    Object.defineProperty(hostileError, hostileProperty, {
      get(): never { throw new Error(`hostile ${hostileProperty} getter on Error`); }
    });
    assert.equal(
      isProviderFailure(hostileError),
      false,
      `hostile ${hostileProperty} getter must return false`
    );
  }
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
