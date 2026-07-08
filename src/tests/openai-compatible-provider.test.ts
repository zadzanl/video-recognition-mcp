import { describe, it, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { createRecognitionProvider } from '../services/recognition-providers.js';
import type {
  OpenAICompatibleRecognitionConfig,
  RecognitionProvider
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

function parseRequestBody(body: BodyInit | null | undefined): CapturedRequestBody {
  return JSON.parse(String(body)) as CapturedRequestBody;
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