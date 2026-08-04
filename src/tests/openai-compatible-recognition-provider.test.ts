/**
 * status: active
 * phase: phase-4a-standalone-adapter
 * sprint: provider-foundation-first-sprint
 * last_modified: 2026-08-04
 * agent_notes: "Credential-free matrix for Phase 4a: media MIME, request construction, strict response, full error_type and HTTP fallback, redirect, Retry-After, network, redaction, source assertions."
 * insights: "Phase 4a is a complete standalone adapter; Phase 4b adds timeout, bounded reader, model grammar, and containment. Tests cover every normative row of the spec without live network or real credentials."
 */

import assert from 'node:assert/strict';
import {
  mkdtemp,
  readFile,
  rm,
  writeFile
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import {
  OpenAICompatibleRecognitionProvider
} from '../services/openai-compatible-recognition-provider.js';
import type { OpenAICompatibleProviderConfig } from '../services/provider-config.js';
import type {
  MediaKind,
  ProviderFailure,
  RecognitionRequest
} from '../types/provider.js';

interface FetchCall {
  input: unknown;
  init: RequestInit | null;
}

const FIXTURE_KEY = 'credential-free-test-key';
const LEAKED_KEY_FRAGMENT = 'leaked-credential-fragment';
const LEAKED_PROMPT_FRAGMENT = 'leaked-prompt-fragment';
const LEAKED_MODEL_FRAGMENT = 'leaked-model-fragment';
const LEAKED_PATH_FRAGMENT = 'leaked-path-fragment';

const config = (overrides: Partial<OpenAICompatibleProviderConfig> = {}): OpenAICompatibleProviderConfig => ({
  provider: 'openai-compatible',
  apiKey: FIXTURE_KEY,
  baseUrl: new URL('https://openrouter.ai/api/v1/chat/completions'),
  model: 'configured-model',
  providerLabel: 'Test provider',
  requestTimeoutSeconds: 60,
  maxResponseBytes: 1024,
  maxInlineMediaBytes: 1024,
  allowedMediaRoots: ['C:\\placeholder\\root'],
  allowInsecureLocal: false,
  ...overrides
});

const request = (overrides: Partial<RecognitionRequest> = {}): RecognitionRequest => ({
  filepath: 'fixture.jpg',
  prompt: 'describe fixture',
  mediaKind: 'image',
  ...overrides
});

const unexpectedAccess = (property: string): never => {
  throw new Error(`${property} must not be read`);
};

const captureFailure = async (
  provider: OpenAICompatibleRecognitionProvider,
  recognitionRequest: RecognitionRequest,
  signal?: AbortSignal
): Promise<ProviderFailure> => {
  try {
    await provider.recognize(
      recognitionRequest,
      signal === undefined ? undefined : { signal }
    );
    assert.fail('expected provider failure');
  } catch (error) {
    assert.equal(error instanceof Error, true);
    return error as ProviderFailure;
  }
};

const jsonResponse = (body: unknown, status = 200, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers }
  });

const recordingFetch = (
  responder: (call: FetchCall) => Response | Error
): { fetchFn: typeof globalThis.fetch; calls: FetchCall[] } => {
  const calls: FetchCall[] = [];
  const fetchFn: typeof globalThis.fetch = (async (
    input: RequestInfo | URL,
    init?: RequestInit
  ): Promise<Response> => {
    const call: FetchCall = { input, init: init ?? null };
    calls.push(call);
    const result = responder(call);
    if (result instanceof Error) throw result;
    return result;
  }) as typeof globalThis.fetch;
  return { fetchFn, calls };
};

const throwFetch = (error: Error): { fetchFn: typeof globalThis.fetch; calls: FetchCall[] } =>
  recordingFetch(() => error);

const tempRoot = await mkdtemp(path.join(tmpdir(), 'openai-compatible-'));

const writeTempFile = async (filename: string, bytes: number | Buffer): Promise<string> => {
  const filepath = path.join(tempRoot, filename);
  const data = typeof bytes === 'number' ? Buffer.alloc(bytes) : bytes;
  await writeFile(filepath, data);
  return filepath;
};

before(async () => {
  // Ensure temp root exists for all tests.
  await writeTempFile('.keep', 0);
});

after(async () => {
  await rm(tempRoot, { recursive: true, force: true });
});

const supportedImageExtensions = ['.jpg', '.jpeg', '.png', '.webp'] as const;
const supportedAudioExtensions = ['.wav', '.mp3'] as const;
const supportedVideoExtensions = ['.mp4', '.mpeg', '.mov', '.webm'] as const;
const supportedMimeByExtension: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mp3',
  '.mp4': 'video/mp4',
  '.mpeg': 'video/mpeg',
  '.mov': 'video/mov',
  '.webm': 'video/webm'
};

const successBody = (text: string): unknown => ({
  choices: [{ message: { content: text } }]
});

test('pre-aborted caller throws cancelled with no fetch and no config or request access', async () => {
  const { fetchFn, calls } = throwFetch(new Error('should not be reached'));
  const hostileConfig = config();
  Object.defineProperty(hostileConfig, 'modelAllowlist', {
    get: () => unexpectedAccess('modelAllowlist')
  });
  const provider = new OpenAICompatibleRecognitionProvider(hostileConfig, fetchFn);
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
  assert.equal(calls.length, 0);
});

test('allowlist uses exact equality and rejects before filepath or fetch work', async () => {
  const accepted = recordingFetch(() => jsonResponse(successBody('recognized')));
  const acceptedProvider = new OpenAICompatibleRecognitionProvider(
    config({ modelAllowlist: ['Allowed-Model'] }),
    accepted.fetchFn
  );
  const acceptedFilepath = await writeTempFile('accept.jpg', Buffer.from('x'));
  const acceptedResult = await acceptedProvider.recognize(
    request({ model: 'Allowed-Model', filepath: acceptedFilepath })
  );
  assert.deepEqual(acceptedResult, { text: 'recognized' });
  assert.equal(accepted.calls.length, 1);

  const rejected = throwFetch(new Error('should not be reached'));
  const rejectedProvider = new OpenAICompatibleRecognitionProvider(
    config({ modelAllowlist: ['Allowed-Model'] }),
    rejected.fetchFn
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
  assert.equal(rejected.calls.length, 0);
});

test('allowlist rejection safe message never echoes requested, default, allowed models, or credentials', async () => {
  const { fetchFn, calls } = throwFetch(new Error('should not be reached'));
  const provider = new OpenAICompatibleRecognitionProvider(
    config({
      apiKey: LEAKED_KEY_FRAGMENT,
      model: 'Default-Model',
      modelAllowlist: ['Allowed-One', 'Allowed-Two']
    }),
    fetchFn
  );
  const failure = await captureFailure(provider, request({ model: 'Requested-Model' }));
  assert.equal(failure.category, 'invalid-request');
  assert.equal(failure.safeMessage, 'Requested model is not allowed.');
  for (const leaked of [
    'Requested-Model',
    'Default-Model',
    'Allowed-One',
    'Allowed-Two',
    LEAKED_KEY_FRAGMENT
  ]) {
    assert.equal(failure.safeMessage.includes(leaked), false, `safeMessage leaked: ${leaked}`);
  }
  assert.equal(calls.length, 0);
});

test('every supported media pair reaches fetch with exact MIME and content part', async () => {
  const cases: readonly (readonly [MediaKind, string, 'image' | 'audio' | 'video'])[] = [
    ...supportedImageExtensions.map(ext => ['image', ext, 'image'] as const),
    ...supportedAudioExtensions.map(ext => ['audio', ext, 'audio'] as const),
    ...supportedVideoExtensions.map(ext => ['video', ext, 'video'] as const)
  ];
  for (const [mediaKind, extension, _tag] of cases) {
    const { fetchFn, calls } = recordingFetch(() => jsonResponse(successBody('ok')));
    const provider = new OpenAICompatibleRecognitionProvider(config(), fetchFn);
    const filepath = await writeTempFile(`fixture${extension}`, Buffer.from('payload'));
    const result = await provider.recognize(request({ filepath, mediaKind }));
    assert.deepEqual(result, { text: 'ok' });
    assert.equal(calls.length, 1);
    const init = calls[0]?.init;
    assert.equal(init?.method, 'POST');
    const body = JSON.parse(String(init?.body)) as {
      messages: { content: Record<string, unknown>[] }[];
    };
    const parts = body.messages[0]?.content ?? [];
    const textPart = parts[0];
    const mediaPart = parts[1];
    assert.equal(textPart?.type, 'text');
    assert.equal(mediaPart?.type === 'image_url'
      || mediaPart?.type === 'input_audio'
      || mediaPart?.type === 'video_url', true);
    const expectedMime = supportedMimeByExtension[extension];
    assert.ok(expectedMime, `unknown extension ${extension}`);
    if (mediaPart?.type === 'image_url') {
      const url = String((mediaPart.image_url as { url: string }).url);
      assert.equal(url.startsWith(`data:${expectedMime};base64,`), true);
    } else if (mediaPart?.type === 'video_url') {
      const url = String((mediaPart.video_url as { url: string }).url);
      assert.equal(url.startsWith(`data:${expectedMime};base64,`), true);
    } else if (mediaPart?.type === 'input_audio') {
      const data = String((mediaPart.input_audio as { data: string }).data);
      assert.equal(data.startsWith('data:'), false);
      const format = (mediaPart.input_audio as { format: string }).format;
      assert.equal(['wav', 'mp3'].includes(format), true);
      assert.equal(supportedMimeByExtension[extension], `audio/${format}`);
    }
  }
});

test('uppercase extensions are normalized to lowercase MIME and content part', async () => {
  for (const [mediaKind, upper] of [['image', '.JPG'], ['audio', '.WAV'], ['video', '.MOV']] as const) {
    const { fetchFn, calls } = recordingFetch(() => jsonResponse(successBody('ok')));
    const provider = new OpenAICompatibleRecognitionProvider(config(), fetchFn);
    const filepath = await writeTempFile(`fixture${upper}`, Buffer.from('payload'));
    await provider.recognize(request({ filepath, mediaKind }));
    const body = JSON.parse(String(calls[0]?.init?.body)) as {
      messages: { content: Record<string, unknown>[] }[];
    };
    const mediaPart = body.messages[0]?.content[1];
    if (mediaKind === 'image') {
      const url = String((mediaPart?.image_url as { url: string }).url);
      assert.equal(url.startsWith('data:image/jpeg;base64,'), true);
    } else if (mediaKind === 'audio') {
      const format = (mediaPart?.input_audio as { format: string }).format;
      assert.equal(format, 'wav');
    } else {
      const url = String((mediaPart?.video_url as { url: string }).url);
      assert.equal(url.startsWith('data:video/mov;base64,'), true);
    }
  }
});

test('unsupported, wrong-kind, and missing extensions throw unsupported-media with zero fetch', async () => {
  const cases: readonly (readonly [MediaKind, string])[] = [
    ['image', '.gif'],
    ['image', '.avi'],
    ['audio', '.gif'],
    ['video', '.avi'],
    ['video', '.gif'],
    ['image', '.mp3'],
    ['audio', '.png'],
    ['video', '.wav'],
    ['image', '']
  ];
  for (const [mediaKind, extension] of cases) {
    const { fetchFn, calls } = throwFetch(new Error('should not be reached'));
    const provider = new OpenAICompatibleRecognitionProvider(config(), fetchFn);
    const filepath = `virtual${extension === '' ? '' : 'X'}${extension}`;
    const failure = await captureFailure(
      provider,
      request({ filepath: extension === '' ? 'no-extension' : filepath, mediaKind })
    );
    assert.equal(failure.category, 'unsupported-media', `extension=${extension} kind=${mediaKind}`);
    assert.equal(calls.length, 0);
  }
});

test('file size equal to maxInlineMediaBytes reaches fetch', async () => {
  const { fetchFn, calls } = recordingFetch(() => jsonResponse(successBody('ok')));
  const provider = new OpenAICompatibleRecognitionProvider(
    config({ maxInlineMediaBytes: 64 }),
    fetchFn
  );
  const filepath = await writeTempFile('boundary.jpg', 64);
  const result = await provider.recognize(request({ filepath }));
  assert.deepEqual(result, { text: 'ok' });
  assert.equal(calls.length, 1);
});

test('file size plus one throws unsupported-media before read or fetch', async () => {
  const { fetchFn, calls } = throwFetch(new Error('should not be reached'));
  const provider = new OpenAICompatibleRecognitionProvider(
    config({ maxInlineMediaBytes: 64 }),
    fetchFn
  );
  const filepath = await writeTempFile('oversize.jpg', 65);
  const failure = await captureFailure(provider, request({ filepath }));
  assert.equal(failure.category, 'unsupported-media');
  assert.equal(calls.length, 0);
});

test('request is a single POST to config.baseUrl with bearer, JSON, redirect manual, no attribution', async () => {
  const { fetchFn, calls } = recordingFetch(() => jsonResponse(successBody('ok')));
  const baseUrl = new URL('https://example.test/v1/chat/completions');
  const provider = new OpenAICompatibleRecognitionProvider(
    config({ apiKey: 'sk-test-bearer', baseUrl }),
    fetchFn
  );
  const filepath = await writeTempFile('bearer.png', Buffer.from('payload'));
  await provider.recognize(request({ filepath, mediaKind: 'image', prompt: 'PROMPT-SECRET' }));
  assert.equal(calls.length, 1);
  const call = calls[0];
  assert.equal(String(call?.input), baseUrl.toString());
  const init = call?.init;
  assert.equal(init?.method, 'POST');
  assert.equal(init?.redirect, 'manual');
  const headers = init?.headers as Record<string, string>;
  assert.equal(headers.Authorization, 'Bearer sk-test-bearer');
  assert.equal(headers['Content-Type'], 'application/json');
  for (const forbidden of [
    'HTTP-Referer',
    'X-OpenRouter-Title',
    'X-Title',
    'X-Request-Id'
  ]) {
    assert.equal(Object.keys(headers).some(k => k.toLowerCase() === forbidden.toLowerCase()), false);
  }
  const body = JSON.parse(String(init?.body)) as {
    model: string;
    stream: boolean;
    messages: { role: string; content: Record<string, unknown>[] }[];
  };
  assert.equal(body.model, 'configured-model');
  assert.equal(body.stream, false);
  assert.equal(body.messages[0]?.role, 'user');
  assert.equal(body.messages[0]?.content[0]?.type, 'text');
  assert.equal(body.messages[0]?.content[0]?.text, 'PROMPT-SECRET');
  const second = body.messages[0]?.content[1];
  assert.equal(second?.type, 'image_url');
});

test('request uses explicit model override and preserves text-first order', async () => {
  const { fetchFn, calls } = recordingFetch(() => jsonResponse(successBody('ok')));
  const provider = new OpenAICompatibleRecognitionProvider(config(), fetchFn);
  const filepath = await writeTempFile('order.jpg', Buffer.from('payload'));
  await provider.recognize(
    request({ filepath, mediaKind: 'image', model: 'explicit-override', prompt: 'hello' })
  );
  const body = JSON.parse(String(calls[0]?.init?.body)) as {
    model: string;
    messages: { content: Record<string, unknown>[] }[];
  };
  assert.equal(body.model, 'explicit-override');
  assert.equal(body.messages[0]?.content[0]?.type, 'text');
  assert.equal(body.messages[0]?.content[1]?.type, 'image_url');
});

test('success returns original untrimmed text without provider fields', async () => {
  const { fetchFn } = recordingFetch(() => jsonResponse({
    choices: [{ message: { content: '  exact-text  ' } }]
  }));
  const provider = new OpenAICompatibleRecognitionProvider(config(), fetchFn);
  const filepath = await writeTempFile('success.jpg', Buffer.from('payload'));
  const result = await provider.recognize(request({ filepath }));
  assert.deepEqual(result, { text: '  exact-text  ' });
});

test('whitespace-only content throws malformed-response without flattening', async () => {
  const { fetchFn } = recordingFetch(() => jsonResponse({
    choices: [{ message: { content: '   \n\t  ' } }]
  }));
  const provider = new OpenAICompatibleRecognitionProvider(config(), fetchFn);
  const filepath = await writeTempFile('ws.jpg', Buffer.from('payload'));
  const failure = await captureFailure(provider, request({ filepath }));
  assert.equal(failure.category, 'malformed-response');
});

test('non-string, null, array, object, and missing content throw malformed-response', async () => {
  for (const content of [null, 42, true, false, ['text'], { foo: 'bar' }]) {
    const { fetchFn } = recordingFetch(() => jsonResponse({
      choices: [{ message: { content } }]
    }));
    const provider = new OpenAICompatibleRecognitionProvider(config(), fetchFn);
    const filepath = await writeTempFile(`bad-${Math.random()}.jpg`, Buffer.from('payload'));
    const failure = await captureFailure(provider, request({ filepath }));
    assert.equal(failure.category, 'malformed-response', `content=${JSON.stringify(content)}`);
  }
  for (const body of [
    { choices: [] },
    { choices: [{}] },
    { choices: [{ message: {} }] },
    { choices: [{ message: { content: '' } }] },
    { not_choices: [] }
  ]) {
    const { fetchFn } = recordingFetch(() => jsonResponse(body));
    const provider = new OpenAICompatibleRecognitionProvider(config(), fetchFn);
    const filepath = await writeTempFile(`shape-${Math.random()}.jpg`, Buffer.from('payload'));
    const failure = await captureFailure(provider, request({ filepath }));
    assert.equal(failure.category, 'malformed-response', `body=${JSON.stringify(body)}`);
  }
});

test('finish_reason error and choice-level error markers throw malformed-response', async () => {
  for (const choice of [
    { finish_reason: 'error', message: { content: 'partial' } },
    { error: { code: 500, message: 'INJECTED-SECRET' }, message: { content: 'partial' } }
  ]) {
    const { fetchFn } = recordingFetch(() => jsonResponse({ choices: [choice] }));
    const provider = new OpenAICompatibleRecognitionProvider(config(), fetchFn);
    const filepath = await writeTempFile(`marker-${Math.random()}.jpg`, Buffer.from('payload'));
    const failure = await captureFailure(provider, request({ filepath }));
    assert.equal(failure.category, 'malformed-response', `choice=${JSON.stringify(choice)}`);
  }
});

test('invalid and empty 2xx JSON throws malformed-response', async () => {
  for (const body of ['not-json', '', '   ']) {
    const { fetchFn } = recordingFetch(() => new Response(body, { status: 200 }));
    const provider = new OpenAICompatibleRecognitionProvider(config(), fetchFn);
    const filepath = await writeTempFile(`json-${Math.random()}.jpg`, Buffer.from('payload'));
    const failure = await captureFailure(provider, request({ filepath }));
    assert.equal(failure.category, 'malformed-response', `body=${JSON.stringify(body)}`);
  }
});

test('error_type table maps every row and precedence beats HTTP status', async () => {
  const cases: readonly (readonly [string, string, number])[] = [
    ['authentication', 'authentication', 401],
    ['permission_denied', 'permission', 403],
    ['payment_required', 'billing', 402],
    ['rate_limit_exceeded', 'rate-limit', 429],
    ['provider_overloaded', 'temporary-service', 503],
    ['provider_unavailable', 'temporary-service', 502],
    ['server', 'temporary-service', 500],
    ['timeout', 'timeout', 504],
    ['content_policy_violation', 'safety', 400],
    ['refusal', 'safety', 400],
    ['invalid_image', 'unsupported-media', 400],
    ['image_too_large', 'unsupported-media', 400],
    ['image_too_small', 'unsupported-media', 400],
    ['unsupported_image_format', 'unsupported-media', 400],
    ['image_not_found', 'unsupported-media', 404],
    ['image_download_failed', 'unsupported-media', 400],
    ['context_length_exceeded', 'invalid-request', 400],
    ['max_tokens_exceeded', 'invalid-request', 400],
    ['token_limit_exceeded', 'invalid-request', 400],
    ['string_too_long', 'invalid-request', 400],
    ['invalid_request', 'invalid-request', 400],
    ['invalid_prompt', 'invalid-request', 400],
    ['not_found', 'invalid-request', 404],
    ['precondition_failed', 'invalid-request', 412],
    ['payload_too_large', 'invalid-request', 413],
    ['unprocessable', 'invalid-request', 422]
  ];
  for (const [errorType, expectedCategory, status] of cases) {
    const { fetchFn } = recordingFetch(() => jsonResponse({
      error: {
        code: status,
        message: 'INJECTED-SECRET',
        metadata: { error_type: errorType, provider_code: 'INJECTED-CODE' }
      }
    }, status));
    const provider = new OpenAICompatibleRecognitionProvider(config(), fetchFn);
    const filepath = await writeTempFile(`err-${errorType}.jpg`, Buffer.from('payload'));
    const failure = await captureFailure(provider, request({ filepath }));
    assert.equal(failure.category, expectedCategory, `error_type=${errorType}`);
    assert.equal(failure.status, status);
    assert.equal(failure.safeMessage.includes('INJECTED-SECRET'), false);
    assert.equal(failure.safeMessage.includes('INJECTED-CODE'), false);
  }
});

test('unmapped error_type falls through to HTTP-status fallback', async () => {
  const { fetchFn } = recordingFetch(() => jsonResponse({
    error: { code: 401, message: 'INJECTED', metadata: { error_type: 'unmapped' } }
  }, 401));
  const provider = new OpenAICompatibleRecognitionProvider(config(), fetchFn);
  const filepath = await writeTempFile('unmapped.jpg', Buffer.from('payload'));
  const failure = await captureFailure(provider, request({ filepath }));
  assert.equal(failure.category, 'authentication');
  assert.equal(failure.status, 401);
});

test('choice-level error_type precedence beats HTTP status', async () => {
  const { fetchFn } = recordingFetch(() => jsonResponse({
    choices: [
      {
        error: {
          code: 500,
          message: 'INJECTED-SECRET',
          metadata: { error_type: 'rate_limit_exceeded' }
        },
        message: { content: 'partial text' }
      }
    ]
  }, 200));
  const provider = new OpenAICompatibleRecognitionProvider(config(), fetchFn);
  const filepath = await writeTempFile('prec.jpg', Buffer.from('payload'));
  const failure = await captureFailure(provider, request({ filepath }));
  assert.equal(failure.category, 'rate-limit');
  assert.equal(failure.status, 200);
  assert.equal(failure.safeMessage.includes('partial text'), false);
});

test('HTTP-status fallback maps every named status and 4xx/5xx catch-alls', async () => {
  const cases: readonly (readonly [number, string])[] = [
    [400, 'invalid-request'],
    [401, 'authentication'],
    [402, 'billing'],
    [403, 'permission'],
    [404, 'invalid-request'],
    [408, 'timeout'],
    [412, 'invalid-request'],
    [413, 'invalid-request'],
    [415, 'unsupported-media'],
    [422, 'invalid-request'],
    [429, 'rate-limit'],
    [500, 'temporary-service'],
    [502, 'temporary-service'],
    [503, 'temporary-service'],
    [504, 'timeout'],
    [418, 'invalid-request'],
    [524, 'temporary-service'],
    [529, 'temporary-service'],
    [418, 'invalid-request'],
    [599, 'temporary-service']
  ];
  for (const [status, expectedCategory] of cases) {
    const { fetchFn } = recordingFetch(() => jsonResponse({
      error: { code: status, message: 'INJECTED', metadata: { provider_code: 'INJECTED-CODE' } }
    }, status));
    const provider = new OpenAICompatibleRecognitionProvider(config(), fetchFn);
    const filepath = await writeTempFile(`http-${status}.jpg`, Buffer.from('payload'));
    const failure = await captureFailure(provider, request({ filepath }));
    assert.equal(failure.category, expectedCategory, `status=${status}`);
    assert.equal(failure.status, status);
    assert.equal(failure.safeMessage.includes('INJECTED'), false);
  }
});

test('3xx rejects as unknown with one original-origin fetch and no second attempt', async () => {
  for (const status of [301, 302, 303, 307, 308]) {
    const { fetchFn, calls } = recordingFetch(() => new Response(null, { status }));
    const provider = new OpenAICompatibleRecognitionProvider(config(), fetchFn);
    const filepath = await writeTempFile(`redir-${status}.jpg`, Buffer.from('payload'));
    const failure = await captureFailure(provider, request({ filepath }));
    assert.equal(failure.category, 'unknown', `status=${status}`);
    assert.equal(failure.status, status);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.init?.redirect, 'manual');
  }
});

test('Retry-After accepts finite decimal seconds; invalid values are omitted; no second fetch', async () => {
  for (const [headerValue, expected] of [
    ['0', 0],
    ['1', 1000],
    ['60', 60000],
    ['1.5', 1500]
  ] as const) {
    const { fetchFn, calls } = recordingFetch(() => jsonResponse({
      error: { code: 429, message: 'INJECTED', metadata: { error_type: 'rate_limit_exceeded' } }
    }, 429, { 'retry-after': headerValue }));
    const provider = new OpenAICompatibleRecognitionProvider(config(), fetchFn);
    const filepath = await writeTempFile(`ra-${headerValue}.jpg`, Buffer.from('payload'));
    const failure = await captureFailure(provider, request({ filepath }));
    assert.equal(failure.category, 'rate-limit');
    assert.equal(failure.retryAfterMs, expected);
    assert.equal(calls.length, 1);
  }
  for (const headerValue of ['-1', 'abc', 'tomorrow', '1e10', '', '   ']) {
    const { fetchFn, calls } = recordingFetch(() => jsonResponse({
      error: { code: 429, message: 'INJECTED', metadata: { error_type: 'rate_limit_exceeded' } }
    }, 429, { 'retry-after': headerValue }));
    const provider = new OpenAICompatibleRecognitionProvider(config(), fetchFn);
    const filepath = await writeTempFile(`ra-bad-${Math.random()}.jpg`, Buffer.from('payload'));
    const failure = await captureFailure(provider, request({ filepath }));
    assert.equal(failure.category, 'rate-limit');
    assert.equal(failure.retryAfterMs, undefined);
    assert.equal(calls.length, 1);
  }
});

test('unowned fetch throw maps to network with non-enumerable cause', async () => {
  const cause = new Error('DNS lookup failed INJECTED-SECRET');
  const { fetchFn, calls } = throwFetch(cause);
  const provider = new OpenAICompatibleRecognitionProvider(config(), fetchFn);
  const filepath = await writeTempFile('net.jpg', Buffer.from('payload'));
  const failure = await captureFailure(provider, request({ filepath }));
  assert.equal(failure.category, 'network');
  assert.equal(failure.cause, cause);
  assert.equal(Object.getOwnPropertyDescriptor(failure, 'cause')?.enumerable, false);
  assert.equal(failure.safeMessage.includes('INJECTED-SECRET'), false);
  assert.equal(calls.length, 1);
});

test('caller mid-call abort after fetch begins maps to cancelled with CALLER_CANCELLED', async () => {
  const controller = new AbortController();
  const cause = new Error('aborted INJECTED-SECRET');
  cause.name = 'AbortError';
  const { fetchFn, calls } = recordingFetch(() => {
    controller.abort();
    throw cause;
  });
  const provider = new OpenAICompatibleRecognitionProvider(config(), fetchFn);
  const filepath = await writeTempFile('abort.jpg', Buffer.from('payload'));
  const failure = await captureFailure(
    provider,
    request({ filepath }),
    controller.signal
  );
  assert.equal(failure.category, 'cancelled');
  assert.equal(failure.code, 'CALLER_CANCELLED');
  assert.equal(calls.length, 1);
  assert.equal(failure.safeMessage.includes('INJECTED-SECRET'), false);
});

test('public failure text and serialization never include credentials, prompts, models, paths, body, or status text', async () => {
  const secretKey = `sk-${LEAKED_KEY_FRAGMENT}-secret`;
  const secretPrompt = `describe ${LEAKED_PROMPT_FRAGMENT}`;
  const secretModel = LEAKED_MODEL_FRAGMENT;
  const secretFilepath = await writeTempFile('redact.jpg', Buffer.from('payload'));
  const secretPathFragment = LEAKED_PATH_FRAGMENT;
  const { fetchFn } = recordingFetch(() => jsonResponse({
    error: {
      code: 429,
      message: 'INJECTED-UPSTREAM-MESSAGE',
      metadata: { error_type: 'rate_limit_exceeded', provider_code: 'INJECTED-CODE' }
    }
  }, 429, { 'retry-after': '60' }));
  const provider = new OpenAICompatibleRecognitionProvider(
    config({ apiKey: secretKey, model: secretModel }),
    fetchFn
  );
  const failure = await captureFailure(
    provider,
    request({ filepath: secretFilepath, prompt: secretPrompt, model: secretModel })
  );
  const publicText = [
    failure.safeMessage,
    JSON.stringify(failure),
    JSON.stringify({ ...failure })
  ].join('|');
  for (const secret of [
    secretKey,
    secretPrompt,
    secretModel,
    secretPathFragment,
    secretFilepath,
    'INJECTED-UPSTREAM-MESSAGE',
    'INJECTED-CODE',
    secretPathFragment
  ]) {
    assert.equal(publicText.includes(secret), false, `leaked: ${secret}`);
  }
});

test('adapter source uses incremental reader and excludes forbidden behaviors and tokens', async () => {
  const source = await readFile(
    path.resolve(process.cwd(), 'src/services/openai-compatible-recognition-provider.ts'),
    'utf8'
  );
  assert.match(source, /getReader\(\)/u);
  assert.match(source, /new TextDecoder\(\)/u);
  assert.doesNotMatch(source, /response\.text\(\)/u);
  assert.doesNotMatch(source, /response\.arrayBuffer\(\)/u);
  for (const token of [
    /\bfallback\b/iu,
    /\bcooldown\b/iu,
    /\brouting\b/iu,
    /\bparallel\b/iu,
    /\bthrottl/iu,
    /\bcache\b/iu,
    /\btelemetry\b/iu,
    /AbortSignal\.any/u
  ]) {
    assert.doesNotMatch(source, token, `forbidden token in source: ${token}`);
  }
  // Retry-After diagnostic parsing is allowed; no automated retry logic may appear.
  assert.doesNotMatch(source, /\bretry\s*\(/iu);
  assert.doesNotMatch(source, /setTimeout\s*\(\s*retry/iu);
  assert.match(source, /\bredirect: 'manual'/u);
  assert.match(source, /video\/mov/u);
  assert.match(source, /audio\/mp3/u);
});
