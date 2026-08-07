/**
 * status: active
 * phase: change-b-group-1-pin-contract
 * sprint: gemini-model-fallback-and-rate-limit-recovery
 * last_modified: 2026-08-07
 * agent_notes: "Direct adapter matrix now covers validated one-attempt pins and route immutability without adding routing behavior."
 * insights: "Invalid, non-string, and disallowed pins fail before filepath/service access; cooling and pin-driven cooldown effects remain Groups 3-4 work."
 */

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import {
  GeminiRecognitionProvider
} from '../services/gemini-recognition-provider.js';
import {
  GeminiService,
  GeminiVideoProcessingTimeoutError
} from '../services/gemini.js';
import {
  loadRecognitionProviderConfig,
  type GeminiProviderConfig
} from '../services/provider-config.js';
import type { GeminiFile, GeminiResponse } from '../types/index.js';
import type { ProviderFailure, RecognitionRequest } from '../types/provider.js';

interface ServiceCalls {
  uploadedPaths: string[];
  generations: { file: GeminiFile; prompt: string; model: string }[];
  wrapperCalls: number;
}

interface FakeOptions {
  uploadError?: unknown;
  generationError?: unknown;
  text?: string;
}

const config = (overrides: Partial<GeminiProviderConfig> = {}): GeminiProviderConfig => ({
  provider: 'gemini',
  apiKey: 'credential-free-test-key',
  model: 'configured-model',
  recovery: {
    modelRoute: ['configured-model'],
    maxAttempts: 4,
    deadlineSeconds: 30,
    baseBackoffMs: 250,
    maxBackoffMs: 2000,
    cooldownSeconds: 60,
    backup: { enabled: false }
  },
  ...overrides
});

const request = (overrides: Partial<RecognitionRequest> = {}): RecognitionRequest => ({
  filepath: 'fixture.png',
  prompt: 'describe fixture',
  mediaKind: 'image',
  ...overrides
});

const unexpectedAccess = (property: string): never => {
  throw new Error(`${property} must not be read`);
};

const fakeService = (options: FakeOptions = {}): { service: GeminiService; calls: ServiceCalls } => {
  const calls: ServiceCalls = { uploadedPaths: [], generations: [], wrapperCalls: 0 };
  const file: GeminiFile = { uri: 'gemini://fixture', mimeType: 'image/png', name: 'fixture' };
  const service = {
    uploadFile: async (filepath: string): Promise<GeminiFile> => {
      calls.uploadedPaths.push(filepath);
      if (options.uploadError !== undefined) throw options.uploadError;
      return file;
    },
    processFileOrThrow: async (
      uploadedFile: GeminiFile,
      prompt: string,
      model: string
    ): Promise<GeminiResponse> => {
      calls.generations.push({ file: uploadedFile, prompt, model });
      if (options.generationError !== undefined) throw options.generationError;
      return { text: options.text ?? 'recognized text' };
    },
    processFile: async (): Promise<GeminiResponse> => {
      calls.wrapperCalls += 1;
      return { text: 'forbidden wrapper result' };
    }
  } as unknown as GeminiService;
  return { service, calls };
};

const captureFailure = async (
  provider: GeminiRecognitionProvider,
  recognitionRequest: RecognitionRequest,
  signal?: AbortSignal
): Promise<ProviderFailure> => {
  try {
    await provider.recognize(recognitionRequest, signal === undefined ? undefined : { signal });
    assert.fail('expected provider failure');
  } catch (error) {
    assert.equal(error instanceof Error, true);
    return error as ProviderFailure;
  }
};

test('success is text-only and uses configured/default or explicit model exactly once', async () => {
  for (const [model, expected] of [[undefined, 'configured-model'], ['explicit-model', 'explicit-model']] as const) {
    const { service, calls } = fakeService({ text: 'exact result' });
    const provider = new GeminiRecognitionProvider(service, config());
    assert.deepEqual(await provider.recognize(request({ model })), { text: 'exact result' });
    assert.equal(calls.uploadedPaths.length, 1);
    assert.equal(calls.generations.length, 1);
    assert.equal(calls.generations[0]?.model, expected);
    assert.equal(calls.wrapperCalls, 0);
  }
});

test('pre-aborted caller performs zero model, filepath, or service work', async () => {
  const { service, calls } = fakeService();
  const hostileConfig = config();
  Object.defineProperty(hostileConfig, 'modelAllowlist', {
    get: () => unexpectedAccess('allowlist')
  });
  const provider = new GeminiRecognitionProvider(service, hostileConfig);
  const controller = new AbortController();
  controller.abort();
  const hostileRequest = {
    get filepath(): string { return unexpectedAccess('filepath'); },
    get prompt(): string { return unexpectedAccess('prompt'); },
    get mediaKind(): 'image' { return unexpectedAccess('mediaKind'); },
    get model(): string { return unexpectedAccess('model'); }
  } as RecognitionRequest;

  const failure = await captureFailure(provider, hostileRequest, controller.signal);
  assert.equal(failure.category, 'cancelled');
  assert.equal(failure.code, 'CALLER_CANCELLED');
  assert.equal(calls.uploadedPaths.length, 0);
  assert.equal(calls.generations.length, 0);
});

test('allowlist uses exact equality and rejects before filepath or service work', async () => {
  const accepted = fakeService();
  const acceptedProvider = new GeminiRecognitionProvider(
    accepted.service,
    config({ modelAllowlist: ['Allowed-Model'] })
  );
  await acceptedProvider.recognize(request({ model: 'Allowed-Model' }));
  assert.equal(accepted.calls.uploadedPaths.length, 1);

  const rejected = fakeService();
  const rejectedProvider = new GeminiRecognitionProvider(
    rejected.service,
    config({ modelAllowlist: ['Allowed-Model'] })
  );
  const rejectedRequest = {
    model: 'allowed-model',
    get filepath(): string { return unexpectedAccess('filepath'); },
    get prompt(): string { return unexpectedAccess('prompt'); },
    get mediaKind(): 'image' { return unexpectedAccess('mediaKind'); }
  } as RecognitionRequest;
  const failure = await captureFailure(rejectedProvider, rejectedRequest);
  assert.equal(failure.category, 'invalid-request');
  assert.equal(failure.safeMessage, 'Requested model is not allowed.');
  assert.equal(rejected.calls.uploadedPaths.length, 0);
});

test('primary, later-route, and allowed off-route pins each make one call without route mutation', async () => {
  const route = ['primary-model', 'later-model'] as const;
  const configured = config({
    model: route[0],
    modelAllowlist: [...route, 'off-route-model'],
    recovery: {
      modelRoute: route,
      maxAttempts: 4,
      deadlineSeconds: 30,
      baseBackoffMs: 250,
      maxBackoffMs: 2000,
      cooldownSeconds: 60,
      backup: { enabled: false }
    }
  });
  const routeBefore = [...configured.recovery.modelRoute];

  for (const pin of ['primary-model', 'later-model', 'off-route-model']) {
    const { service, calls } = fakeService();
    const provider = new GeminiRecognitionProvider(service, configured);
    await provider.recognize(request({ model: pin }));
    assert.deepEqual(calls.uploadedPaths, ['fixture.png']);
    assert.equal(calls.generations.length, 1);
    assert.equal(calls.generations[0]?.model, pin);
    assert.deepEqual(configured.recovery.modelRoute, routeBefore);
  }
});

test('invalid pins fail before filepath, upload, or generation access', async () => {
  for (const model of [
    '', '😀'.repeat(201), `bad\u0000model`, `bad\u0085model`,
    `bad\u200Emodel`, `bad\u202Emodel`, `bad\u2066model`, `bad\u2028model`
  ]) {
    const { service, calls } = fakeService();
    const provider = new GeminiRecognitionProvider(service, config());
    const hostileRequest = {
      model,
      get filepath(): string { return unexpectedAccess('filepath'); },
      get prompt(): string { return unexpectedAccess('prompt'); },
      get mediaKind(): 'image' { return unexpectedAccess('mediaKind'); }
    } as RecognitionRequest;
    const failure = await captureFailure(provider, hostileRequest);
    assert.equal(failure.category, 'invalid-request');
    assert.equal(failure.safeMessage, 'Requested model is invalid.');
    if (model.length > 0) assert.equal(failure.safeMessage.includes(model), false);
    assert.equal(calls.uploadedPaths.length, 0);
    assert.equal(calls.generations.length, 0);
  }
});

test('runtime non-string pin fails as invalid-request before filepath or service access', async () => {
  const { service, calls } = fakeService();
  const provider = new GeminiRecognitionProvider(service, config());
  const hostileRequest = {
    model: { length: 5 },
    get filepath(): string { return unexpectedAccess('filepath'); },
    get prompt(): string { return unexpectedAccess('prompt'); },
    get mediaKind(): 'image' { return unexpectedAccess('mediaKind'); }
  } as unknown as RecognitionRequest;

  const failure = await captureFailure(provider, hostileRequest);
  assert.equal(failure.category, 'invalid-request');
  assert.equal(failure.safeMessage, 'Requested model is invalid.');
  assert.equal(calls.uploadedPaths.length, 0);
  assert.equal(calls.generations.length, 0);
});

test('cooling-pin bypass and pin cooldown mutation remain deferred until Groups 3-4', () => {
  // No cooldown store exists in Group 1. The executable contract here is validation,
  // exact one-call pinning, pre-I/O rejection, and route immutability only.
  assert.equal('cooldownStore' in config().recovery, false);
});

test('allowlist rejection safe message never echoes requested, default, allowed models, or credentials', async () => {
  const { service, calls } = fakeService();
  const provider = new GeminiRecognitionProvider(
    service,
    config({
      apiKey: 'DO-NOT-ECHO-CREDENTIAL',
      model: 'Default-Model',
      modelAllowlist: ['Allowed-One', 'Allowed-Two']
    })
  );
  const failure = await captureFailure(provider, request({ model: 'Requested-Model' }));
  assert.equal(failure.category, 'invalid-request');
  assert.equal(failure.safeMessage, 'Requested model is not allowed.');
  for (const leaked of ['Requested-Model', 'Default-Model', 'Allowed-One', 'Allowed-Two', 'DO-NOT-ECHO-CREDENTIAL']) {
    assert.equal(failure.safeMessage.includes(leaked), false);
  }
  assert.equal(calls.uploadedPaths.length, 0);
  assert.equal(calls.generations.length, 0);
});

test('all supported Gemini media pairs reach upload including ogg', async () => {
  const cases: readonly ['image' | 'audio' | 'video', string][] = [
    ['image', '.jpg'], ['image', '.jpeg'], ['image', '.png'], ['image', '.webp'],
    ['audio', '.wav'], ['audio', '.mp3'], ['audio', '.ogg'],
    ['video', '.mp4']
  ];
  for (const [mediaKind, extension] of cases) {
    const { service, calls } = fakeService();
    const provider = new GeminiRecognitionProvider(service, config());
    await provider.recognize(request({ filepath: `fixture${extension}`, mediaKind }));
    assert.deepEqual(calls.uploadedPaths, [`fixture${extension}`]);
    assert.equal(calls.generations.length, 1);
  }
});

test('mismatches and rejected video formats fail before service work', async () => {
  const cases: readonly ['image' | 'audio' | 'video', string][] = [
    ['image', '.mp3'], ['audio', '.png'], ['video', '.ogg'],
    ['video', '.mpeg'], ['video', '.mov'], ['video', '.avi'], ['video', '.webm'],
    ['image', '.gif'], ['audio', '.flac'], ['video', '']
  ];
  for (const [mediaKind, extension] of cases) {
    const { service, calls } = fakeService();
    const failure = await captureFailure(
      new GeminiRecognitionProvider(service, config()),
      request({ filepath: `fixture${extension}`, mediaKind })
    );
    assert.equal(failure.category, 'unsupported-media');
    assert.equal(calls.uploadedPaths.length, 0);
    assert.equal(calls.generations.length, 0);
  }
});

test('upload and generation failures terminate after one attempt', async () => {
  const upload = fakeService({ uploadError: new Error('upload secret') });
  const uploadFailure = await captureFailure(
    new GeminiRecognitionProvider(upload.service, config()),
    request()
  );
  assert.equal(uploadFailure.category, 'unknown');
  assert.equal(upload.calls.uploadedPaths.length, 1);
  assert.equal(upload.calls.generations.length, 0);

  const generation = fakeService({ generationError: new Error('generation secret') });
  const generationFailure = await captureFailure(
    new GeminiRecognitionProvider(generation.service, config()),
    request()
  );
  assert.equal(generationFailure.category, 'unknown');
  assert.equal(generation.calls.uploadedPaths.length, 1);
  assert.equal(generation.calls.generations.length, 1);
});

test('synthetic contract fixtures map only approved finite numeric statuses', async () => {
  const mapped = [
    [400, 'invalid-request'], [401, 'authentication'], [402, 'billing'],
    [403, 'permission'], [429, 'rate-limit'], [500, 'temporary-service'],
    [503, 'temporary-service']
  ] as const;
  for (const [status, category] of mapped) {
    const { service } = fakeService({ generationError: { status } });
    const failure = await captureFailure(new GeminiRecognitionProvider(service, config()), request());
    assert.equal(failure.category, category);
    assert.equal(failure.status, status);
  }

  const inherited = Object.create({ status: 429 }) as object;
  const inheritedService = fakeService({ generationError: inherited }).service;
  const inheritedFailure = await captureFailure(
    new GeminiRecognitionProvider(inheritedService, config()),
    request()
  );
  assert.equal(inheritedFailure.category, 'rate-limit');
  assert.equal(inheritedFailure.status, 429);
});

test('synthetic invalid and unmapped statuses remain unknown without status', async () => {
  const throwingStatus = Object.create(null) as Record<string, unknown>;
  Object.defineProperty(throwingStatus, 'status', { get: () => { throw new Error('getter secret'); } });
  for (const cause of [
    { status: '429' }, { status: Number.NaN }, { status: Infinity },
    { status: -Infinity }, { status: 404 }, throwingStatus
  ]) {
    const { service } = fakeService({ generationError: cause });
    const failure = await captureFailure(new GeminiRecognitionProvider(service, config()), request());
    assert.equal(failure.category, 'unknown');
    assert.equal(failure.status, undefined);
  }
});

test('message, name, tokens, retryability, and upstream code never alter classification', async () => {
  const variants = [
    new Error('got status: 429 rate limit token exhausted'),
    Object.assign(new Error('server unavailable'), {
      name: 'ApiError', code: 'UPSTREAM_SECRET_CODE', retryable: true, tokens: 0
    })
  ];
  for (const cause of variants) {
    const { service } = fakeService({ uploadError: cause });
    const failure = await captureFailure(new GeminiRecognitionProvider(service, config()), request());
    assert.equal(failure.category, 'unknown');
    assert.equal(failure.status, undefined);
    assert.equal(failure.code, undefined);
  }
});

test('owned timeout identity alone maps to GEMINI_VIDEO_PROCESSING_TIMEOUT', async () => {
  const owned = new GeminiVideoProcessingTimeoutError('sensitive filename');
  const ownedService = fakeService({ uploadError: owned }).service;
  const failure = await captureFailure(new GeminiRecognitionProvider(ownedService, config()), request());
  assert.equal(failure.category, 'timeout');
  assert.equal(failure.code, 'GEMINI_VIDEO_PROCESSING_TIMEOUT');
  assert.equal(failure.status, undefined);

  const impostor = Object.assign(new Error('sensitive filename'), {
    name: 'GeminiVideoProcessingTimeoutError'
  });
  const impostorService = fakeService({ uploadError: impostor }).service;
  const impostorFailure = await captureFailure(
    new GeminiRecognitionProvider(impostorService, config()),
    request()
  );
  assert.equal(impostorFailure.category, 'unknown');
  assert.equal(impostorFailure.code, undefined);
});

test('retained cause is non-enumerable and public failure text is sanitized', async () => {
  const cause = Object.assign(new Error('upstream content secret'), {
    status: 429,
    code: 'UPSTREAM_CODE_SECRET'
  });
  const filepath = 'C:/private/media/secret.png';
  const prompt = 'private prompt secret';
  const model = 'private model secret';
  const { service } = fakeService({ generationError: cause });
  const failure = await captureFailure(
    new GeminiRecognitionProvider(service, config()),
    request({ filepath, prompt, model })
  );

  assert.equal(failure.cause, cause);
  assert.equal(Object.getOwnPropertyDescriptor(failure, 'cause')?.enumerable, false);
  const publicText = `${failure.safeMessage}${JSON.stringify(failure)}${JSON.stringify({ ...failure })}`;
  for (const secret of [filepath, prompt, model, cause.message, cause.code]) {
    assert.equal(publicText.includes(secret), false);
  }
  assert.equal(failure.safeMessage.includes('429'), false);
});

test('valid Gemini config composes directly through the pinned constructor', async () => {
  const loaded = await loadRecognitionProviderConfig({ GOOGLE_API_KEY: 'composition-key' });
  assert.equal(loaded.provider, 'gemini');
  if (loaded.provider !== 'gemini') assert.fail('wrong provider branch');
  const { service } = fakeService({ text: 'composed result' });
  const provider = new GeminiRecognitionProvider(service, loaded);
  assert.deepEqual(await provider.recognize(request()), { text: 'composed result' });
});

test('adapter source contains no forbidden future-sprint behavior or wrapper call', async () => {
  const source = await readFile(
    path.resolve(process.cwd(), 'src/services/gemini-recognition-provider.ts'),
    'utf8'
  );
  assert.match(source, /\.processFileOrThrow\(/u);
  assert.doesNotMatch(source, /\.processFile\(/u);
  assert.doesNotMatch(source, /\bfetch\s*\(|OpenAI|allowedMediaRoots|realpath|readFile/u);
  assert.doesNotMatch(source, /retry|fallback|cooldown|routing|parallel|throttl/iu);
  assert.doesNotMatch(source, /\.message|\.name|\.code|retryable|tokens|ApiError|ClientError|ServerError/u);
  assert.doesNotMatch(source, /setTimeout|AbortController|AbortSignal\.any/u);
});