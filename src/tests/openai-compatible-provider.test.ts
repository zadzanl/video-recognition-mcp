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
  body: any;
  headers: Record<string, string>;
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
    const content = body.messages[1].content as Array<any>;
    assert.deepStrictEqual(content.map(part => part.type), ['text', 'image_url', 'text']);
    assert.strictEqual(content[0].text, 'Describe the image.');
    assert.match(content[1].image_url.url, /^data:image\/png;base64,/);
    assert.strictEqual(content[2].text, 'Focus on visible labels.');
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
    const content = body.messages[1].content as Array<any>;
    assert.deepStrictEqual(content.map(part => part.type), ['text', 'image_url']);
    assert.strictEqual(content[0].text, 'Use this complete prompt first.');
    assert.match(content[1].image_url.url, /^data:image\/png;base64,/);
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

      const content = calls[0].body.messages[0].content as Array<any>;
      assert.deepStrictEqual(content.map(part => part.type), ['text', testCase.expectedMediaType, 'text']);
      assert.strictEqual(content[0].text, 'Stable prompt prefix.');
      assert.strictEqual(content[2].text, 'Variable prompt suffix.');

      if (testCase.mediaKind === 'audio') {
        assert.strictEqual(content[1].input_audio.format, 'wav');
        assert.ok(content[1].input_audio.data.length > 0);
      } else {
        assert.match(content[1].video_url.url, /^data:video\/mp4;base64,/);
      }
    });
  }
});

describe('OpenAI-compatible text synthesis request bodies', () => {
  it('sets session id on text synthesis only when provided', async () => {
    const calls: CapturedFetchCall[] = [];
    stubFetch(calls);
    const provider = makeProvider();

    await provider.synthesizeText!('Prompt without session.');
    await provider.synthesizeText!('Prompt with session.', { sessionId: 'session-text-1' });

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

      await provider.synthesizeText!('Prompt.');

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

function makeProvider(overrides: Partial<OpenAICompatibleRecognitionConfig> = {}): RecognitionProvider {
  return createRecognitionProvider({
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
}

function stubFetch(calls: CapturedFetchCall[]): void {
  global.fetch = async (_url, init): Promise<any> => {
    assert.ok(init);
    assert.strictEqual(init.method, 'POST');
    calls.push({
      body: JSON.parse(String(init.body)),
      headers: init.headers as Record<string, string>
    });

    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      text: async () => JSON.stringify({
        choices: [{ message: { content: 'stub response' } }]
      })
    };
  };
}