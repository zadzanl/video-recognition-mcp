import { describe, it, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { createRecognitionProvider } from '../services/recognition-providers.js';
import type {
  OpenAICompatibleRecognitionConfig,
  RecognitionProvider,
  RecognitionResult
} from '../types/index.js';

interface CapturedFetchCall {
  body: CapturedRequestBody;
  headers: Record<string, string>;
}

interface CapturedTextContentPart {
  type: 'text';
  text: string;
}

interface CapturedImageContentPart {
  type: 'image_url';
  image_url: { url: string };
}

interface CapturedVideoContentPart {
  type: 'video_url';
  video_url: { url: string };
}

interface CapturedAudioContentPart {
  type: 'input_audio';
  input_audio: { data: string; format: string };
}

type CapturedMessageContentPart =
  | CapturedTextContentPart
  | CapturedImageContentPart
  | CapturedVideoContentPart
  | CapturedAudioContentPart;

interface CapturedRequestMessage {
  role: 'system' | 'developer' | 'user';
  content: string | CapturedMessageContentPart[];
}

interface CapturedRequestBody {
  model: string;
  messages: CapturedRequestMessage[];
  session_id?: string;
}

type TestRecognitionProvider = RecognitionProvider & {
  synthesizeText: NonNullable<RecognitionProvider['synthesizeText']>;
};

interface OpenAICompatibleFailureOrigin {
  kind: 'http' | 'transport' | 'local' | 'structural';
  stage?: 'fetch' | 'response-read' | 'validation' | 'encoding' | 'request-build' | 'unsupported-response-shape';
  status?: number;
  error?: unknown;
}

let tmpDir: string;
let imagePath: string;
let audioPath: string;
let videoPath: string;

const originalFetch = global.fetch;

before(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openai-compatible-provider-test-'));
  imagePath = path.join(tmpDir, 'image.png');
  audioPath = path.join(tmpDir, 'audio.wav');
  videoPath = path.join(tmpDir, 'video.mp4');

  fs.writeFileSync(
    imagePath,
    Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64')
  );
  fs.writeFileSync(audioPath, Buffer.from('RIFFtestWAVEfmt data'));
  fs.writeFileSync(videoPath, Buffer.from('ftypmp42minimal'));
});

after(() => {
  global.fetch = originalFetch;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

afterEach(() => {
  global.fetch = originalFetch;
});

describe('OpenAI-compatible recognition provider request bodies', () => {
  it('builds image recognition body with stable instruction, prompt layout, and session id', async () => {
    const calls: CapturedFetchCall[] = [];
    stubFetch(calls);
    const provider = makeProvider();

    const result = await provider.recognize(
      {
        filepath: imagePath,
        prompt: 'Full flattened prompt should not be used here.',
        mediaKind: 'image'
      },
      {
        sessionId: 'session-image-1',
        stableInstruction: {
          role: 'developer',
          text: 'Use stable image recognition rules.'
        },
        promptLayout: {
          stableTextPrefix: 'Describe the image.',
          variableTextSuffix: 'Focus on visible labels.'
        }
      }
    );

    assert.strictEqual(result.text, 'stub response');
    assert.strictEqual(calls.length, 1);
    const body = calls[0].body;
    assert.deepStrictEqual(Object.keys(body), ['model', 'messages', 'session_id']);
    assert.strictEqual(body.session_id, 'session-image-1');
    assert.strictEqual(body.messages.length, 2);
    assert.deepStrictEqual(body.messages[0], {
      role: 'developer',
      content: 'Use stable image recognition rules.'
    });
    assert.strictEqual(body.messages[1].role, 'user');
    const content = readContentParts(body.messages[1].content);
    assert.deepStrictEqual(content.map(part => part.type), ['text', 'image_url', 'text']);
    assert.strictEqual(expectContentPart(content[0], 'text').text, 'Describe the image.');
    assert.match(expectContentPart(content[1], 'image_url').image_url.url, /^data:image\/png;base64,/);
    assert.strictEqual(expectContentPart(content[2], 'text').text, 'Focus on visible labels.');
  });

  it('keeps full request prompt before media when prompt layout is missing', async () => {
    const calls: CapturedFetchCall[] = [];
    stubFetch(calls);
    const provider = makeProvider();

    await provider.recognize(
      {
        filepath: imagePath,
        prompt: 'Use this complete prompt first.',
        mediaKind: 'image'
      },
      {
        stableInstruction: {
          role: 'system',
          text: 'Use stable recognition rules.'
        }
      }
    );

    const body = calls[0].body;
    assert.deepStrictEqual(Object.keys(body), ['model', 'messages']);
    assert.strictEqual(Object.prototype.hasOwnProperty.call(body, 'session_id'), false);
    assert.strictEqual(body.messages.length, 2);
    assert.deepStrictEqual(body.messages[0], {
      role: 'system',
      content: 'Use stable recognition rules.'
    });
    const content = readContentParts(body.messages[1].content);
    assert.deepStrictEqual(content.map(part => part.type), ['text', 'image_url']);
    assert.strictEqual(expectContentPart(content[0], 'text').text, 'Use this complete prompt first.');
    assert.match(expectContentPart(content[1], 'image_url').image_url.url, /^data:image\/png;base64,/);
  });

  for (const testCase of [
    {
      name: 'audio',
      mediaKind: 'audio' as const,
      getFilepath: () => audioPath,
      expectedMediaType: 'input_audio'
    },
    {
      name: 'video',
      mediaKind: 'video' as const,
      getFilepath: () => videoPath,
      expectedMediaType: 'video_url'
    }
  ]) {
    it(`builds ${testCase.name} prompt layout content in text, media, suffix order`, async () => {
      const calls: CapturedFetchCall[] = [];
      stubFetch(calls);
      const provider = makeProvider();

      await provider.recognize(
        {
          filepath: testCase.getFilepath(),
          prompt: 'Flattened prompt with suffix.',
          mediaKind: testCase.mediaKind
        },
        {
          promptLayout: {
            stableTextPrefix: 'Stable prompt prefix.',
            variableTextSuffix: 'Variable prompt suffix.'
          }
        }
      );

      const content = readContentParts(calls[0].body.messages[0].content);
      assert.deepStrictEqual(content.map(part => part.type), ['text', testCase.expectedMediaType, 'text']);
      assert.strictEqual(expectContentPart(content[0], 'text').text, 'Stable prompt prefix.');
      assert.strictEqual(expectContentPart(content[2], 'text').text, 'Variable prompt suffix.');

      if (testCase.mediaKind === 'audio') {
        const audioPart = expectContentPart(content[1], 'input_audio');
        assert.strictEqual(audioPart.input_audio.format, 'wav');
        assert.ok(audioPart.input_audio.data.length > 0);
      } else {
        assert.match(expectContentPart(content[1], 'video_url').video_url.url, /^data:video\/mp4;base64,/);
      }
    });
  }
});

describe('OpenAI-compatible text synthesis request bodies', () => {
  it('sets session id on text synthesis only when provided', async () => {
    const calls: CapturedFetchCall[] = [];
    stubFetch(calls);
    const provider = makeProvider();

    await provider.synthesizeText('Prompt without session.');
    await provider.synthesizeText('Prompt with session.', { sessionId: 'session-text-1' });

    assert.strictEqual(calls.length, 2);
    assert.deepStrictEqual(Object.keys(calls[0].body), ['model', 'messages']);
    assert.strictEqual(Object.prototype.hasOwnProperty.call(calls[0].body, 'session_id'), false);
    assert.strictEqual(calls[0].body.messages[0].content, 'Prompt without session.');
    assert.deepStrictEqual(Object.keys(calls[1].body), ['model', 'messages', 'session_id']);
    assert.strictEqual(calls[1].body.session_id, 'session-text-1');
    assert.strictEqual(calls[1].body.messages[0].content, 'Prompt with session.');
  });
});

describe('OpenAI-compatible usage telemetry', () => {
  it('leaves usage absent when the provider omits it for recognition and synthesis', async () => {
    const provider = makeProvider();
    global.fetch = async (): Promise<Response> => successResponse({
      choices: [{ message: { content: 'successful assistant text' } }]
    });

    const recognition = await provider.recognize({
      filepath: imagePath,
      prompt: 'Recognize this image.',
      mediaKind: 'image'
    });
    const synthesis = await provider.synthesizeText('Synthesize this text.');

    assert.deepStrictEqual(recognition, { text: 'successful assistant text' });
    assert.deepStrictEqual(synthesis, { text: 'successful assistant text' });
  });

  it('keeps valid assistant text when usage or prompt token details are null', async () => {
    const provider = makeProvider();
    const responses = [
      { choices: [{ message: { content: 'usage null' } }], usage: null },
      {
        choices: [{ message: { content: 'details null' } }],
        usage: { prompt_tokens_details: null }
      }
    ];
    global.fetch = async (): Promise<Response> => successResponse(responses.shift());

    assert.deepStrictEqual(await provider.synthesizeText('First prompt.'), { text: 'usage null' });
    assert.deepStrictEqual(await provider.synthesizeText('Second prompt.'), { text: 'details null' });
  });

  it('preserves explicit zero token counters', async () => {
    const provider = makeProvider();
    global.fetch = async (): Promise<Response> => successResponse({
      id: 'response-zero',
      model: 'provider-model',
      choices: [{ message: { content: 'zero counters' } }],
      usage: {
        prompt_tokens: 0,
        completion_tokens: 0,
        total_tokens: 0,
        prompt_tokens_details: {
          cached_tokens: 0,
          cache_write_tokens: 0,
          image_tokens: 0,
          audio_tokens: 0,
          video_tokens: 0
        }
      }
    });

    const result = await provider.synthesizeText('Prompt with zero counters.');

    assert.deepStrictEqual(result, {
      text: 'zero counters',
      usage: {
        responseId: 'response-zero',
        responseModel: 'provider-model',
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        cachedTokens: 0,
        cacheWriteTokens: 0,
        imageTokens: 0,
        audioTokens: 0,
        videoTokens: 0
      }
    });
  });

  it('retains valid usage siblings while rejecting malformed counters and raw payload fields', async () => {
    const provider = makeProvider();
    global.fetch = async (): Promise<Response> => successResponse({
      id: 'response-positive',
      model: 'provider-model',
      api_key: 'secret-provider-key',
      session_id: 'provider-session-id',
      headers: { authorization: 'Bearer secret-token' },
      choices: [{ message: { content: 'mixed telemetry remains successful' } }],
      usage: {
        prompt_tokens: 12,
        completion_tokens: '3',
        total_tokens: -1,
        prompt_tokens_details: {
          cached_tokens: 7,
          cache_write_tokens: 5,
          image_tokens: 2,
          audio_tokens: 3,
          video_tokens: 4,
          ignored: 'payload'
        }
      }
    });

    const result = await provider.synthesizeText('Prompt with mixed telemetry.');

    assert.deepStrictEqual(result, {
      text: 'mixed telemetry remains successful',
      usage: {
        responseId: 'response-positive',
        responseModel: 'provider-model',
        promptTokens: 12,
        cachedTokens: 7,
        cacheWriteTokens: 5,
        imageTokens: 2,
        audioTokens: 3,
        videoTokens: 4
      }
    });
    assert.ok(!JSON.stringify(result).includes('secret'));
    assert.ok(!JSON.stringify(result).includes('session_id'));
    assert.ok(!JSON.stringify(result).includes('headers'));
  });

  it('keeps valid assistant text when telemetry shapes are malformed', async () => {
    const provider = makeProvider();
    global.fetch = async (): Promise<Response> => successResponse({
      id: ['not-an-id'],
      model: 42,
      choices: [{ message: { content: 'assistant text is authoritative' } }],
      usage: ['not-an-object']
    });

    assert.deepStrictEqual(await provider.synthesizeText('Prompt with malformed telemetry.'), {
      text: 'assistant text is authoritative'
    });
  });
});

describe('OpenAI-compatible OpenRouter response cache header', () => {
  for (const testCase of [
    {
      name: 'adds true for OpenRouter',
      baseUrl: 'https://openrouter.ai/api/v1',
      openRouterResponseCache: true,
      expectedHeader: 'true'
    },
    {
      name: 'adds false for OpenRouter',
      baseUrl: 'https://openrouter.ai/api/v1',
      openRouterResponseCache: false,
      expectedHeader: 'false'
    },
    {
      name: 'omits when unset',
      baseUrl: 'https://openrouter.ai/api/v1',
      expectedHeader: undefined
    },
    {
      name: 'omits for non OpenRouter base URL',
      baseUrl: 'https://api.example.test/v1',
      openRouterResponseCache: true,
      expectedHeader: undefined
    }
  ]) {
    it(testCase.name, async () => {
      const calls: CapturedFetchCall[] = [];
      stubFetch(calls);
      const cacheConfig = testCase.openRouterResponseCache === undefined
        ? {}
        : { openRouterResponseCache: testCase.openRouterResponseCache };
      const provider = makeProvider({
        baseUrl: testCase.baseUrl,
        ...cacheConfig
      });

      await provider.synthesizeText('Prompt.');

      const headers = calls[0].headers;
      const cacheHeaders = Object.keys(headers).filter(header => header.toLowerCase().includes('cache'));
      if (testCase.expectedHeader === undefined) {
        assert.deepStrictEqual(cacheHeaders, []);
      } else {
        assert.deepStrictEqual(cacheHeaders, ['X-OpenRouter-Cache']);
        assert.strictEqual(headers['X-OpenRouter-Cache'], testCase.expectedHeader);
      }
    });
  }
});

describe('OpenAI-compatible error sanitization', () => {
  it('redacts bearer tokens, data URLs, and long payloads in returned errors', async () => {
    const provider = makeProvider();
    const originalFetch = global.fetch;

    global.fetch = async (): Promise<Response> => new Response(
      JSON.stringify({
        error: {
          message: 'Bearer sk-secret123 data:image/png;base64,AAAA ' + 'x'.repeat(500)
        }
      }),
      { status: 500, statusText: 'Server Error' }
    );

    try {
      const result = await provider.synthesizeText('Prompt that will fail.');

      assert.strictEqual(result.isError, true);
      assert.match(result.text, /Test OpenAI Compatible API error \(500 Server Error\)/);
      assert.ok(result.text.includes('Bearer [redacted]') || result.text.includes('[redacted api key]'));
      assert.ok(!result.text.includes('data:image/png;base64'));
      assert.ok(result.text.length < 400);
    } finally {
      global.fetch = originalFetch;
    }
  });
});

describe('OpenAI-compatible failure origins', () => {
  it('tags fetch failures with the original error and keeps the origin private', async () => {
    const provider = makeProvider();
    const fetchError = new Error('connection reset');
    global.fetch = async (): Promise<Response> => {
      throw fetchError;
    };

    const result = await provider.synthesizeText('Prompt that cannot be sent.');
    const origin = expectFailureOrigin(result);

    assert.strictEqual(origin.error, fetchError);
    assert.deepStrictEqual(origin, {
      kind: 'transport',
      stage: 'fetch',
      error: fetchError
    });
  });

  it('tags response-read failures with the response status and original error', async () => {
    const provider = makeProvider();
    const responseReadError = new Error('body stream failed');
    global.fetch = async (): Promise<Response> => ({
      ok: false,
      status: 503,
      statusText: 'Service Unavailable',
      text: async (): Promise<string> => {
        throw responseReadError;
      }
    } as Response);

    const result = await provider.synthesizeText('Prompt with unreadable response.');
    const origin = expectFailureOrigin(result);

    assert.strictEqual(origin.error, responseReadError);
    assert.deepStrictEqual(origin, {
      kind: 'transport',
      stage: 'response-read',
      status: 503,
      error: responseReadError
    });
  });

  it('tags readable non-OK responses as HTTP failures', async () => {
    const provider = makeProvider();
    global.fetch = async (): Promise<Response> => new Response(
      JSON.stringify({ error: { message: 'upstream rejected request' } }),
      { status: 429, statusText: 'Too Many Requests' }
    );

    const result = await provider.synthesizeText('Prompt with HTTP failure.');
    const origin = expectFailureOrigin(result);

    assert.deepStrictEqual(origin, { kind: 'http', status: 429 });
  });

  it('tags local validation and encoding failures before fetch', async () => {
    const validationProvider = makeProvider();
    let fetchCalled = false;
    global.fetch = async (): Promise<Response> => {
      fetchCalled = true;
      throw new Error('fetch must not be called for local failures');
    };

    const validationResult = await validationProvider.recognize({
      filepath: path.join(tmpDir, 'missing.png'),
      prompt: 'Validate this missing file.',
      mediaKind: 'image'
    });
    const validationOrigin = expectFailureOrigin(validationResult);
    assert.strictEqual(validationOrigin.kind, 'local');
    assert.strictEqual(validationOrigin.stage, 'validation');
    assert.ok(validationOrigin.error instanceof Error);

    const encodingProvider = makeProvider({ maxInlineMediaBytes: 1 });
    const encodingResult = await encodingProvider.recognize({
      filepath: imagePath,
      prompt: 'Encode this image.',
      mediaKind: 'image'
    });
    const encodingOrigin = expectFailureOrigin(encodingResult);
    assert.strictEqual(encodingOrigin.kind, 'local');
    assert.strictEqual(encodingOrigin.stage, 'encoding');
    assert.ok(encodingOrigin.error instanceof Error);
    assert.strictEqual(fetchCalled, false);
  });

  it('tags local request-build failures with the original error', async () => {
    const requestBuildError = new Error('api key coercion failed');
    const apiKey = {
      [Symbol.toPrimitive](): never {
        throw requestBuildError;
      }
    } as unknown as string;
    const provider = makeProvider({ apiKey });

    const result = await provider.synthesizeText('Prompt with invalid request configuration.');
    const origin = expectFailureOrigin(result);

    assert.strictEqual(origin.error, requestBuildError);
    assert.deepStrictEqual(origin, {
      kind: 'local',
      stage: 'request-build',
      error: requestBuildError
    });
  });

  it('tags malformed 2xx responses as structural failures and leaves successes untagged', async () => {
    const provider = makeProvider();
    global.fetch = async (): Promise<Response> => new Response(
      JSON.stringify({ choices: [] }),
      { status: 200, statusText: 'OK' }
    );

    const malformedResult = await provider.synthesizeText('Prompt with malformed response.');
    const malformedOrigin = expectFailureOrigin(malformedResult);
    assert.deepStrictEqual(malformedOrigin, {
      kind: 'structural',
      stage: 'unsupported-response-shape'
    });

    const calls: CapturedFetchCall[] = [];
    stubFetch(calls);
    const successResult = await provider.synthesizeText('Prompt with valid response.');
    assert.strictEqual(successResult.isError, undefined);
    assert.deepStrictEqual(Object.getOwnPropertySymbols(successResult), []);
  });

  it('treats malformed choice content parts as structural failures instead of throwing', async () => {
    const provider = makeProvider();
    global.fetch = async (): Promise<Response> => new Response(
      JSON.stringify({ choices: [{ message: { content: [null] } }] }),
      { status: 200, statusText: 'OK' }
    );

    const result = await provider.synthesizeText('Prompt with hostile malformed response.');

    assert.strictEqual(result.isError, true);
    assert.match(result.text, /unsupported or empty text synthesis response shape/);
    assert.deepStrictEqual(expectFailureOrigin(result), {
      kind: 'structural',
      stage: 'unsupported-response-shape'
    });
  });
});

function makeProvider(overrides: Partial<OpenAICompatibleRecognitionConfig> = {}): TestRecognitionProvider {
  const provider = createRecognitionProvider({
    provider: 'openai-compatible',
    providerLabel: 'Test OpenAI Compatible',
    modelName: 'test-model',
    apiKey: 'test-key',
    baseUrl: 'https://api.example.test/v1',
    maxInlineMediaBytes: 1024 * 1024,
    parallelInference: {
      enabled: false,
      dispatchMode: 'concurrent',
      promptCount: 1,
      aggregation: 'all_return',
      promptTemplates: [],
      headerMergeTemplate: '',
      llmMergePrompt: ''
    },
    ...overrides
  });

  if (!provider.synthesizeText) {
    throw new Error('Test provider must support text synthesis');
  }

  return provider as TestRecognitionProvider;
}

function readContentParts(content: CapturedRequestMessage['content']): CapturedMessageContentPart[] {
  assert.ok(Array.isArray(content));
  return content;
}

function expectContentPart<TType extends CapturedMessageContentPart['type']>(
  part: CapturedMessageContentPart,
  type: TType
): Extract<CapturedMessageContentPart, { type: TType }> {
  assert.strictEqual(part.type, type);
  return part as Extract<CapturedMessageContentPart, { type: TType }>;
}

function expectFailureOrigin(result: RecognitionResult): OpenAICompatibleFailureOrigin {
  assert.strictEqual(result.isError, true);
  const symbols = Object.getOwnPropertySymbols(result);
  assert.strictEqual(symbols.length, 1);

  const descriptor = Object.getOwnPropertyDescriptor(result, symbols[0]);
  assert.ok(descriptor);
  assert.strictEqual(descriptor.enumerable, false);
  assert.strictEqual(descriptor.writable, false);
  assert.strictEqual(descriptor.configurable, false);
  assert.deepStrictEqual(Object.keys(result), ['text', 'isError']);
  assert.deepStrictEqual({ ...result }, { text: result.text, isError: true });
  assert.strictEqual(JSON.stringify(result), JSON.stringify({ text: result.text, isError: true }));

  return descriptor.value as OpenAICompatibleFailureOrigin;
}

function parseRequestBody(body: BodyInit | null | undefined): CapturedRequestBody {
  return JSON.parse(String(body)) as CapturedRequestBody;
}

function successResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, statusText: 'OK' });
}

function stubFetch(calls: CapturedFetchCall[]): void {
  global.fetch = async (_url, init): Promise<Response> => {
    assert.ok(init);
    assert.strictEqual(init.method, 'POST');
    calls.push({
      body: parseRequestBody(init.body),
      headers: init.headers as Record<string, string>
    });

    return new Response(
      JSON.stringify({
        choices: [{ message: { content: 'stub response' } }]
      }),
      { status: 200, statusText: 'OK' }
    );
  };
}