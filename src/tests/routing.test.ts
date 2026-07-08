/**
 * Tests for rate-limit aware tracking, throttling queue, and cross-provider failover routing.
 */

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { RateLimitTracker } from '../services/rate-limit-tracker.js';
import { ThrottlingScheduler } from '../services/throttling-scheduler.js';
import { classifyGeminiError } from '../services/gemini-error-classifier.js';
import { GeminiRecognitionProvider, classifyOpenAiError } from '../services/recognition-providers.js';
import type { GeminiFile, GeminiResponse, ProviderCallOptions, RecognitionRequest } from '../types/index.js';
import { buildParallelInferenceConfig } from '../services/provider-config.js';
import type { GeminiService } from '../services/gemini.js';

type GeminiServiceMock = Partial<Pick<GeminiService, 'uploadFile' | 'processFile' | 'processText'>>;

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

let globalTestTmpDir: string;

before(() => {
  globalTestTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-routing-global-test-'));
  process.env.RATE_LIMIT_TRACKER_PATH = path.join(globalTestTmpDir, 'mcp-rate-limits-test.json');
});

after(() => {
  delete process.env.RATE_LIMIT_TRACKER_PATH;
  try {
    fs.rmSync(globalTestTmpDir, { recursive: true, force: true });
  } catch {}
});

beforeEach(() => {
  new RateLimitTracker().clearAll();
});

describe('Throttling Config & Loading', () => {
  it('loads config/throttling-limits.json and gets configured limits', () => {
    const tracker = new RateLimitTracker();
    const limits = tracker.getLimitsForModel('gemini-3.5-flash');
    assert.strictEqual(limits.Short_limit_request_cap, 5);
    assert.strictEqual(limits.Short_limit_duration_in_seconds, 60);
    assert.strictEqual(limits.Long_limit_request_cap, 20);
    assert.strictEqual(limits.Long_limit_token_cap, 500000);
  });

  it('falls back to default rules for unknown models', () => {
    const tracker = new RateLimitTracker();
    const limits = tracker.getLimitsForModel('some-completely-unknown-model-name');
    assert.strictEqual(limits.Short_limit_request_cap, 5);
    assert.strictEqual(limits.Long_limit_request_cap, 20);
  });
});

describe('RateLimitTracker state persistence and safety', () => {
  let tempTrackerFile: string;

  before(() => {
    tempTrackerFile = process.env.RATE_LIMIT_TRACKER_PATH || path.join(os.tmpdir(), 'mcp-video-recognition-rate-limits.json');
  });

  it('persists requests in tracker state file without leaking API keys', () => {
    const tracker = new RateLimitTracker();
    const model = 'gemini-3.5-flash';
    
    // Proactively record a request attempt
    tracker.recordAttempt(model, 1000);
    
    // Read directly from file to verify format and secrecy
    assert.ok(fs.existsSync(tempTrackerFile), 'State file should exist');
    const raw = fs.readFileSync(tempTrackerFile, 'utf8');
    const parsed = JSON.parse(raw);
    
    assert.ok(parsed.models[model], 'Model rate state should be stored');
    assert.ok(parsed.models[model].shortRequestTimestamps.length >= 1);
    
    // Verify security: No secrets stored
    assert.strictEqual(raw.includes('key'), false, 'Should not contain key word');
    assert.strictEqual(raw.includes('API_KEY'), false, 'Should not contain API_KEY');
  });

  it('marks cooldowns and correctly skips cooling-down models', () => {
    const tracker = new RateLimitTracker();
    const model = 'gemini-3-flash-preview';
    
    assert.strictEqual(tracker.isModelAvailable(model), true, 'Model should be initially available');
    
    // Mark cooldown
    tracker.markCooldown(model, 10000);
    assert.strictEqual(tracker.isModelAvailable(model), false, 'Model should not be available in cooldown');
    
    // Clear cooldown
    tracker.clearCooldown(model);
    assert.strictEqual(tracker.isModelAvailable(model), true, 'Model should be available again after clearing cooldown');
  });
});

describe('ThrottlingScheduler Queue & Timing', () => {
  it('schedules available model immediately', async () => {
    const tracker = new RateLimitTracker();
    const scheduler = new ThrottlingScheduler(tracker);
    const model = 'gemini-2.5-flash';
    
    // Clear state
    tracker.clearCooldown(model);
    
    const selected = await scheduler.scheduleRequest([model], 'image', 1000);
    assert.strictEqual(selected, model);
  });

  it('times out when all models are rate limited', async () => {
    const tracker = new RateLimitTracker();
    const scheduler = new ThrottlingScheduler(tracker);
    const model = 'gemini-2.5-flash';
    
    // Force rate limit by filling short cap (5 requests)
    for (let i = 0; i < 5; i++) {
      tracker.recordAttempt(model, 100);
    }
    
    assert.strictEqual(tracker.isModelAvailable(model), false, 'Model should be full');
    
    const startTime = Date.now();
    await assert.rejects(
      async () => {
        await scheduler.scheduleRequest([model], 'image', 300);
      },
      /Scheduling timeout/
    );
    const elapsed = Date.now() - startTime;
    assert.ok(elapsed >= 300, 'Should wait at least 300ms before timeout');
  });
});

describe('Strict Error Classification Update', () => {
  it('classifies billing precondition error with rate indicators as retryable', () => {
    const err = {
      name: 'ApiError',
      status: 403,
      message: 'BILLING: Free tier quota limit exceeded'
    };
    const c = classifyGeminiError(err);
    assert.strictEqual(c.retryable, true);
    assert.ok(c.reason.includes('rate limit'));
  });

  it('classifies normal billing error without rate indicators as fail-fast', () => {
    const err = {
      name: 'ApiError',
      status: 403,
      message: 'BILLING account not active'
    };
    const c = classifyGeminiError(err);
    assert.strictEqual(c.retryable, false);
    assert.ok(c.reason.includes('billing/account'));
  });

  it('classifies unauthenticated error as fail-fast', () => {
    const err = {
      name: 'ApiError',
      status: 401,
      message: 'API_KEY_INVALID: The provided key is invalid'
    };
    const c = classifyGeminiError(err);
    assert.strictEqual(c.retryable, false);
  });
});

describe('OpenAI-compatible error classification', () => {
  it('classifies retryable network-style errors', () => {
    const retryableMessages = [
      'fetch failed',
      'TypeError: Failed to fetch',
      'ETIMEDOUT while connecting',
      'UND_ERR_CONNECT_TIMEOUT',
      'read ECONNRESET',
      'getaddrinfo EAI_AGAIN',
      'connect ENOTFOUND',
      'socket hang up ECONNREFUSED',
      'request aborted',
      'deadline exceeded'
    ];

    for (const message of retryableMessages) {
      const c = classifyOpenAiError(message);
      assert.strictEqual(c.retryable, true, message);
    }
  });

  it('matches retryable and fail-fast HTTP codes by exact boundary only', () => {
    assert.strictEqual(classifyOpenAiError('HTTP 429 too many requests').retryable, true);
    assert.strictEqual(classifyOpenAiError('HTTP 500 internal error').retryable, true);
    assert.strictEqual(classifyOpenAiError('HTTP 502 bad gateway').retryable, true);
    assert.strictEqual(classifyOpenAiError('HTTP 503 unavailable').retryable, true);
    assert.strictEqual(classifyOpenAiError('HTTP 504 gateway timeout').retryable, true);

    assert.strictEqual(classifyOpenAiError('HTTP 400 bad request').retryable, false);
    assert.strictEqual(classifyOpenAiError('HTTP 402 payment required').retryable, false);
    assert.strictEqual(classifyOpenAiError('HTTP 401 unauthorized').retryable, false);
    assert.strictEqual(classifyOpenAiError('HTTP 403 forbidden').retryable, false);
    assert.strictEqual(classifyOpenAiError('error 1429 happened').retryable, false);
  });

  it('classifies fail-fast text for invalid requests and auth errors', () => {
    assert.strictEqual(classifyOpenAiError('invalid request: unsupported media').retryable, false);
    assert.strictEqual(classifyOpenAiError('permission denied by upstream').retryable, false);
    assert.strictEqual(classifyOpenAiError('invalid api key provided').retryable, false);
  });
});

describe('Cross-Provider Routing Integration', () => {
  const sampleFile: GeminiFile = {
    uri: 'gs://test-bucket/test-file',
    mimeType: 'image/png',
    name: 'test-file',
    state: 'ACTIVE'
  };

  const baseRequest: RecognitionRequest = {
    filepath: 'some-path.png', // Mock filepath, will not be read directly if mocked
    prompt: 'Describe this',
    mediaKind: 'image'
  };

  // Mock valid PNG file creation for validateMediaFile
  let tmpDir: string;
  let testImagePath: string;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-routing-test-'));
    testImagePath = path.join(tmpDir, 'test-image.png');
    fs.writeFileSync(testImagePath, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64'));
  });

  after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('routes to OpenRouter if Gemini fails with retryable rate limit', async () => {
    const processCalls: string[] = [];
    const mockService = {
      uploadFile: async () => sampleFile,
      processFile: async (_f: GeminiFile, _prompt: string, model: string): Promise<GeminiResponse> => {
        processCalls.push(model);
        // Throw retryable rate limit error
        throw Object.assign(new Error('Quota limit hit'), { name: 'ApiError', status: 429 });
      }
    };

    // Construct Gemini provider config with OpenRouter fallback
    const config = {
      provider: 'gemini' as const,
      providerLabel: 'Google Gemini',
      modelName: 'gemini-3.5-flash + fallbacks',
      modelNames: ['gemini-3.5-flash'],
      apiKey: 'test-google-key',
      openRouterApiKey: 'test-openrouter-key',
      openRouterModels: ['google/gemini-2.5-flash'],
      rateLimitMaxWaitMs: 500,
      parallelInference: buildParallelInferenceConfig({})
    };

    // We stub fetch to mock the OpenAI-compatible HTTP response from OpenRouter
    const originalFetch = global.fetch;
    let openRouterCalled = false;
    global.fetch = async (url, init): Promise<Response> => {
      if (typeof url === 'string' && url.includes('openrouter.ai')) {
        openRouterCalled = true;
        const body = parseRequestBody(init);
        assert.strictEqual(body.model, 'google/gemini-2.5-flash');
        return chatCompletionResponse('Success response from OpenRouter!');
      }
      return originalFetch(url, init);
    };

    try {
      const provider = new GeminiRecognitionProvider(config, asGeminiService(mockService));
      const result = await provider.recognize({ ...baseRequest, filepath: testImagePath });

      assert.strictEqual(result.isError, undefined);
      assert.strictEqual(result.text, 'Success response from OpenRouter!');
      assert.deepStrictEqual(processCalls, ['gemini-3.5-flash']);
      assert.strictEqual(openRouterCalled, true);
    } finally {
      global.fetch = originalFetch;
    }
  });

  it('routes from OpenRouter to MiMo when OpenRouter fails retryably', async () => {
    const processCalls: string[] = [];
    const mockService = {
      uploadFile: async () => sampleFile,
      processFile: async (_f: GeminiFile, _prompt: string, model: string): Promise<GeminiResponse> => {
        processCalls.push(model);
        if (model === 'gemini-3.5-flash') {
          throw Object.assign(new Error('Quota limit hit'), { name: 'ApiError', status: 429 });
        }
        return { text: `success from ${model}` };
      }
    };

    const config = {
      provider: 'gemini' as const,
      providerLabel: 'Google Gemini',
      modelName: 'gemini-3.5-flash + fallbacks',
      modelNames: ['gemini-3.5-flash'],
      apiKey: 'test-google-key',
      openRouterApiKey: 'test-openrouter-key',
      openRouterModels: ['google/gemini-2.5-flash'],
      mimoApiKey: 'test-mimo-key',
      mimoModels: ['mimo-v2.5'],
      mimoBaseUrl: 'https://api.xiaomimimo.com/v1',
      rateLimitMaxWaitMs: 500,
      parallelInference: buildParallelInferenceConfig({})
    };

    const originalFetch = global.fetch;
    const fetchCalls: string[] = [];
    global.fetch = async (url, init): Promise<Response> => {
      if (typeof url === 'string') {
        fetchCalls.push(url);
        if (url.includes('openrouter.ai')) {
          const body = parseRequestBody(init);
          assert.strictEqual(body.model, 'google/gemini-2.5-flash');
          return chatCompletionResponse(JSON.stringify({ error: { message: 'fetch failed' } }), 503, 'Service Unavailable');
        }
        if (url.includes('xiaomimimo.com')) {
          const body = parseRequestBody(init);
          assert.strictEqual(body.model, 'mimo-v2.5');
          return chatCompletionResponse('Success from MiMo');
        }
      }

      return originalFetch(url, init);
    };

    try {
      const provider = new GeminiRecognitionProvider(config, asGeminiService(mockService));
      const result = await provider.recognize({ ...baseRequest, filepath: testImagePath });

      assert.strictEqual(result.isError, undefined);
      assert.strictEqual(result.text, 'Success from MiMo');
      assert.deepStrictEqual(processCalls, ['gemini-3.5-flash']);
      assert.ok(fetchCalls.some(url => url.includes('openrouter.ai')));
      assert.ok(fetchCalls.some(url => url.includes('xiaomimimo.com')));
    } finally {
      global.fetch = originalFetch;
    }
  });

  it('fails fast on non-retryable OpenRouter errors without trying MiMo', async () => {
    const processCalls: string[] = [];
    const mockService = {
      uploadFile: async () => sampleFile,
      processFile: async (_f: GeminiFile, _prompt: string, model: string): Promise<GeminiResponse> => {
        processCalls.push(model);
        if (model === 'gemini-3.5-flash') {
          throw Object.assign(new Error('Quota limit hit'), { name: 'ApiError', status: 429 });
        }
        return { text: `unexpected success from ${model}` };
      }
    };

    const config = {
      provider: 'gemini' as const,
      providerLabel: 'Google Gemini',
      modelName: 'gemini-3.5-flash + fallbacks',
      modelNames: ['gemini-3.5-flash'],
      apiKey: 'test-google-key',
      openRouterApiKey: 'test-openrouter-key',
      openRouterModels: ['google/gemini-2.5-flash'],
      mimoApiKey: 'test-mimo-key',
      mimoModels: ['mimo-v2.5'],
      mimoBaseUrl: 'https://api.xiaomimimo.com/v1',
      rateLimitMaxWaitMs: 500,
      parallelInference: buildParallelInferenceConfig({})
    };

    const originalFetch = global.fetch;
    let mimoCalled = false;
    global.fetch = async (url, init): Promise<Response> => {
      if (typeof url === 'string' && url.includes('openrouter.ai')) {
        const body = parseRequestBody(init);
        assert.strictEqual(body.model, 'google/gemini-2.5-flash');
        return chatCompletionResponse(JSON.stringify({ error: { message: 'invalid request: unsupported media' } }), 400, 'Bad Request');
      }
      if (typeof url === 'string' && url.includes('xiaomimimo.com')) {
        mimoCalled = true;
      }

      return originalFetch(url, init);
    };

    try {
      const provider = new GeminiRecognitionProvider(config, asGeminiService(mockService));
      const result = await provider.recognize({ ...baseRequest, filepath: testImagePath });

      assert.strictEqual(result.isError, true);
      assert.ok(result.text.includes('OpenRouter'));
      assert.ok(result.text.includes('invalid request'));
      assert.deepStrictEqual(processCalls, ['gemini-3.5-flash']);
      assert.strictEqual(mimoCalled, false);
    } finally {
      global.fetch = originalFetch;
    }
  });

  it('uses existing parallel inference config when routing to OpenRouter', async () => {
    const mockService = {
      uploadFile: async () => sampleFile,
      processFile: async (): Promise<GeminiResponse> => {
        throw Object.assign(new Error('Quota limit hit'), { name: 'ApiError', status: 429 });
      }
    };

    const config = {
      provider: 'gemini' as const,
      providerLabel: 'Google Gemini',
      modelName: 'gemini-3.5-flash + fallbacks',
      modelNames: ['gemini-3.5-flash'],
      apiKey: 'test-google-key',
      openRouterApiKey: 'test-openrouter-key',
      openRouterModels: ['google/gemini-2.5-flash'],
      rateLimitMaxWaitMs: 500,
      parallelInference: buildParallelInferenceConfig({ PARALLEL_PROMPTS: '2', PARALLEL_AGGREGATION: 'header_merge' })
    };

    const originalFetch = global.fetch;
    const originalAggregation = process.env.PARALLEL_AGGREGATION;
    process.env.PARALLEL_AGGREGATION = 'ALL_RETURN';
    global.fetch = async (url, init): Promise<Response> => {
      if (typeof url === 'string' && url.includes('openrouter.ai')) {
        const body = parseRequestBody(init);
        assert.strictEqual(body.model, 'google/gemini-2.5-flash');
        return chatCompletionResponse('Success despite invalid process env aggregation');
      }
      return originalFetch(url, init);
    };

    try {
      const provider = new GeminiRecognitionProvider(config, asGeminiService(mockService));
      const result = await provider.recognize({ ...baseRequest, filepath: testImagePath });

      assert.strictEqual(result.isError, undefined);
      assert.strictEqual(result.text, 'Success despite invalid process env aggregation');
    } finally {
      if (originalAggregation === undefined) {
        delete process.env.PARALLEL_AGGREGATION;
      } else {
        process.env.PARALLEL_AGGREGATION = originalAggregation;
      }
      global.fetch = originalFetch;
    }
  });

  it('forwards recognition options and OpenRouter cache config to OpenRouter fallback', async () => {
    const mockService = {
      uploadFile: async () => sampleFile,
      processFile: async (): Promise<GeminiResponse> => {
        throw Object.assign(new Error('Quota limit hit'), { name: 'ApiError', status: 429 });
      }
    };

    const config = {
      provider: 'gemini' as const,
      providerLabel: 'Google Gemini',
      modelName: 'gemini-3.5-flash + fallbacks',
      modelNames: ['gemini-3.5-flash'],
      apiKey: 'test-google-key',
      openRouterApiKey: 'test-openrouter-key',
      openRouterModels: ['google/gemini-2.5-flash'],
      openRouterResponseCache: true,
      rateLimitMaxWaitMs: 500,
      parallelInference: buildParallelInferenceConfig({})
    };

    const options: ProviderCallOptions = {
      sessionId: 'routing-session-1',
      stableInstruction: {
        role: 'system',
        text: 'Use stable recognition routing rules.'
      },
      promptLayout: {
        stableTextPrefix: 'Describe the routed image.',
        variableTextSuffix: 'Focus on fallback metadata.'
      }
    };

    const originalFetch = global.fetch;
    let openRouterCalled = false;
    global.fetch = async (url, init): Promise<Response> => {
      if (typeof url === 'string' && url.includes('openrouter.ai')) {
        openRouterCalled = true;
        const headers = readHeaders(init);
        const body = parseRequestBody(init);
        assert.strictEqual(headers['X-OpenRouter-Cache'], 'true');
        assert.strictEqual(body.session_id, 'routing-session-1');
        assert.deepStrictEqual(body.messages[0], {
          role: 'system',
          content: 'Use stable recognition routing rules.'
        });
        const content = readContentParts(body.messages[1].content);
        assert.deepStrictEqual(content.map(part => part.type), ['text', 'image_url', 'text']);
        assert.strictEqual(expectContentPart(content[0], 'text').text, 'Describe the routed image.');
        assert.strictEqual(expectContentPart(content[2], 'text').text, 'Focus on fallback metadata.');
        return chatCompletionResponse('Recognition fallback kept options.');
      }
      return originalFetch(url, init);
    };

    try {
      const provider = new GeminiRecognitionProvider(config, asGeminiService(mockService));
      const result = await provider.recognize({ ...baseRequest, filepath: testImagePath }, options);

      assert.strictEqual(result.isError, undefined);
      assert.strictEqual(result.text, 'Recognition fallback kept options.');
      assert.strictEqual(openRouterCalled, true);
    } finally {
      global.fetch = originalFetch;
    }
  });

  it('forwards synthesis options and OpenRouter cache config to OpenRouter fallback', async () => {
    const processTextCalls: string[] = [];
    const mockService = {
      processText: async (_prompt: string, model: string): Promise<GeminiResponse> => {
        processTextCalls.push(model);
        throw Object.assign(new Error('Quota limit hit'), { name: 'ApiError', status: 429 });
      }
    };

    const config = {
      provider: 'gemini' as const,
      providerLabel: 'Google Gemini',
      modelName: 'gemini-3.5-flash + fallbacks',
      modelNames: ['gemini-3.5-flash'],
      apiKey: 'test-google-key',
      openRouterApiKey: 'test-openrouter-key',
      openRouterModels: ['google/gemini-2.5-flash'],
      openRouterResponseCache: false,
      rateLimitMaxWaitMs: 500,
      parallelInference: buildParallelInferenceConfig({})
    };

    const originalFetch = global.fetch;
    let openRouterCalled = false;
    global.fetch = async (url, init): Promise<Response> => {
      if (typeof url === 'string' && url.includes('openrouter.ai')) {
        openRouterCalled = true;
        const headers = readHeaders(init);
        const body = parseRequestBody(init);
        assert.strictEqual(headers['X-OpenRouter-Cache'], 'false');
        assert.strictEqual(body.session_id, 'synthesis-session-1');
        assert.deepStrictEqual(body.messages, [
          {
            role: 'user',
            content: 'Synthesize routed fallback text.'
          }
        ]);
        return chatCompletionResponse('Synthesis fallback kept options.');
      }
      return originalFetch(url, init);
    };

    try {
      const provider = new GeminiRecognitionProvider(config, asGeminiService(mockService));
      const result = await provider.synthesizeText('Synthesize routed fallback text.', { sessionId: 'synthesis-session-1' });

      assert.strictEqual(result.isError, undefined);
      assert.strictEqual(result.text, 'Synthesis fallback kept options.');
      assert.deepStrictEqual(processTextCalls, ['gemini-3.5-flash']);
      assert.strictEqual(openRouterCalled, true);
    } finally {
      global.fetch = originalFetch;
    }
  });

  it('fails fast on authentication error without attempting OpenRouter', async () => {
    const processCalls: string[] = [];
    const mockService = {
      uploadFile: async () => sampleFile,
      processFile: async (_f: GeminiFile, _prompt: string, model: string): Promise<GeminiResponse> => {
        processCalls.push(model);
        // Throw fail-fast authentication error
        throw Object.assign(new Error('Invalid key'), { name: 'UNAUTHENTICATED', status: 401 });
      }
    };

    const config = {
      provider: 'gemini' as const,
      providerLabel: 'Google Gemini',
      modelName: 'gemini-3.5-flash + fallbacks',
      modelNames: ['gemini-3.5-flash'],
      apiKey: 'test-google-key',
      openRouterApiKey: 'test-openrouter-key',
      openRouterModels: ['google/gemini-2.5-flash'],
      rateLimitMaxWaitMs: 500,
      parallelInference: buildParallelInferenceConfig({})
    };

    const originalFetch = global.fetch;
    let openRouterCalled = false;
    global.fetch = async (url, init): Promise<Response> => {
      if (typeof url === 'string' && url.includes('openrouter.ai')) {
        openRouterCalled = true;
      }
      return originalFetch(url, init);
    };

    try {
      const provider = new GeminiRecognitionProvider(config, asGeminiService(mockService));
      const result = await provider.recognize({ ...baseRequest, filepath: testImagePath });

      assert.strictEqual(result.isError, true);
      assert.ok(result.text.includes('unauthenticated'));
      assert.deepStrictEqual(processCalls, ['gemini-3.5-flash']);
      assert.strictEqual(openRouterCalled, false, 'Should fail-fast and NOT route to OpenRouter');
    } finally {
      global.fetch = originalFetch;
    }
  });
});

function asGeminiService(mock: GeminiServiceMock): GeminiService {
  return mock as unknown as GeminiService;
}

function parseRequestBody(init: RequestInit | undefined): CapturedRequestBody {
  assert.ok(init);
  return JSON.parse(String(init.body)) as CapturedRequestBody;
}

function readHeaders(init: RequestInit | undefined): Record<string, string> {
  assert.ok(init);
  return init.headers as Record<string, string>;
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

function chatCompletionResponse(content: string, status = 200, statusText = 'OK'): Response {
  return new Response(
    status >= 400
      ? content
      : JSON.stringify({
          choices: [{ message: { content } }]
        }),
    { status, statusText }
  );
}
