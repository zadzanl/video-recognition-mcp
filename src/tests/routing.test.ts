/**
 * Tests for rate-limit aware tracking, throttling queue, and cross-provider failover routing.
 */

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { RateLimitTracker, type ModelRateState, type ThrottlingLimitsConfig, type ThrottlingRule } from '../services/rate-limit-tracker.js';
import { ThrottlingScheduler } from '../services/throttling-scheduler.js';
import { classifyGeminiError } from '../services/gemini-error-classifier.js';
import { GeminiRecognitionProvider, classifyOpenAiError } from '../services/recognition-providers.js';
import type { GeminiFile, GeminiResponse, ProviderCallOptions, RecognitionRequest } from '../types/index.js';
import { buildParallelInferenceConfig } from '../services/provider-config.js';
import type { GeminiService } from '../services/gemini.js';
import { Logger, LogLevel } from '../utils/logger.js';

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

const DEFAULT_THROTTLING_RULE: ThrottlingRule = {
  Short_limit_duration_in_seconds: 60,
  Long_limit_duration_in_seconds: 86400,
  Short_limit_request_cap: 5,
  Long_limit_request_cap: 20,
  Short_limit_token_cap: 100000,
  Long_limit_token_cap: 500000
};

const CUSTOM_UNQUALIFIED_RULE: ThrottlingRule = {
  Short_limit_duration_in_seconds: 17,
  Long_limit_duration_in_seconds: 701,
  Short_limit_request_cap: 23,
  Long_limit_request_cap: 47,
  Short_limit_token_cap: 12345,
  Long_limit_token_cap: 67890
};

const CUSTOM_QUALIFIED_RULE: ThrottlingRule = {
  Short_limit_duration_in_seconds: 19,
  Long_limit_duration_in_seconds: 809,
  Short_limit_request_cap: 29,
  Long_limit_request_cap: 53,
  Short_limit_token_cap: 23456,
  Long_limit_token_cap: 78901
};

const HOSTILE_MODEL_IDS = ['constructor', 'toString', '__proto__'] as const;

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
  it('loads the production config without constructor arguments', () => {
    const tracker = new RateLimitTracker();
    const limits = tracker.getLimitsForModel('gemini-3.5-flash');
    assert.strictEqual(limits.Short_limit_request_cap, 5);
    assert.strictEqual(limits.Short_limit_duration_in_seconds, 60);
    assert.strictEqual(limits.Long_limit_request_cap, 20);
    assert.strictEqual(limits.Long_limit_token_cap, 500000);
  });

  it('returns the configured rule for an exact model ID', () => {
    const fixture = writeCustomLimitsFile({ 'exact-model': CUSTOM_UNQUALIFIED_RULE });

    try {
      const tracker = new RateLimitTracker(fixture.limitsPath);
      assert.deepStrictEqual(tracker.getLimitsForModel('exact-model'), CUSTOM_UNQUALIFIED_RULE);
    } finally {
      removeLimitsFixture(fixture.directory);
    }
  });

  it('treats qualified and unqualified model IDs as distinct exact keys', () => {
    const fixture = writeCustomLimitsFile({
      'mimo-v2.5': CUSTOM_UNQUALIFIED_RULE,
      'xiaomi/mimo-v2.5': CUSTOM_QUALIFIED_RULE
    });

    try {
      const tracker = new RateLimitTracker(fixture.limitsPath);
      assert.deepStrictEqual(tracker.getLimitsForModel('mimo-v2.5'), CUSTOM_UNQUALIFIED_RULE);
      assert.deepStrictEqual(tracker.getLimitsForModel('xiaomi/mimo-v2.5'), CUSTOM_QUALIFIED_RULE);
    } finally {
      removeLimitsFixture(fixture.directory);
    }
  });

  it('does not alias prefix, suffix, or substring model ID variants', () => {
    const fixture = writeCustomLimitsFile({ 'exact-model': CUSTOM_UNQUALIFIED_RULE });

    try {
      const tracker = new RateLimitTracker(fixture.limitsPath);
      for (const modelName of ['exact-model-preview', 'provider/exact-model', 'model']) {
        assert.deepStrictEqual(tracker.getLimitsForModel(modelName), DEFAULT_THROTTLING_RULE, modelName);
      }
    } finally {
      removeLimitsFixture(fixture.directory);
    }
  });

  it('returns the full DEFAULT_RULE for unknown models', () => {
    const tracker = new RateLimitTracker();
    const limits = tracker.getLimitsForModel('some-completely-unknown-model-name');
    assert.deepStrictEqual(limits, DEFAULT_THROTTLING_RULE);
  });

  it('warns once per unknown model ID for each tracker instance', () => {
    const originalConsoleError = console.error;
    const messages: string[] = [];
    console.error = (...args: unknown[]): void => {
      messages.push(args.map(String).join(' '));
    };
    Logger.setLogLevel(LogLevel.WARN);

    try {
      const tracker = new RateLimitTracker();
      tracker.getLimitsForModel('unknown-model-warning-once');
      tracker.getLimitsForModel('unknown-model-warning-once');
      tracker.getLimitsForModel('unknown-model-warning-once');

      assert.strictEqual(messages.length, 1);
      assert.match(messages[0] ?? '', /unknown-model-warning-once/);
      assert.match(messages[0] ?? '', /DEFAULT_RULE/);
    } finally {
      console.error = originalConsoleError;
      Logger.setLogLevel(LogLevel.FATAL);
    }
  });

  it('keeps unknown-model warning state independent across tracker instances', () => {
    const originalConsoleError = console.error;
    const messages: string[] = [];
    console.error = (...args: unknown[]): void => {
      messages.push(args.map(String).join(' '));
    };
    Logger.setLogLevel(LogLevel.WARN);

    try {
      const firstTracker = new RateLimitTracker();
      const secondTracker = new RateLimitTracker();
      firstTracker.getLimitsForModel('unknown-model-instance-isolation');
      secondTracker.getLimitsForModel('unknown-model-instance-isolation');

      assert.strictEqual(messages.length, 2);
      for (const message of messages) {
        assert.match(message, /unknown-model-instance-isolation/);
        assert.match(message, /DEFAULT_RULE/);
      }
    } finally {
      console.error = originalConsoleError;
      Logger.setLogLevel(LogLevel.FATAL);
    }
  });

  it('falls back and warns once for each unknown hostile model ID', () => {
    const originalConsoleError = console.error;
    const messages: string[] = [];
    console.error = (...args: unknown[]): void => {
      messages.push(args.map(String).join(' '));
    };
    Logger.setLogLevel(LogLevel.WARN);

    try {
      const tracker = new RateLimitTracker();
      for (const modelName of HOSTILE_MODEL_IDS) {
        assert.deepStrictEqual(tracker.getLimitsForModel(modelName), DEFAULT_THROTTLING_RULE, modelName);
        assert.deepStrictEqual(tracker.getLimitsForModel(modelName), DEFAULT_THROTTLING_RULE, modelName);
      }

      assert.strictEqual(messages.length, HOSTILE_MODEL_IDS.length);
      for (const modelName of HOSTILE_MODEL_IDS) {
        assert.strictEqual(messages.filter(message => message.includes(`"${modelName}"`)).length, 1, modelName);
      }
    } finally {
      console.error = originalConsoleError;
      Logger.setLogLevel(LogLevel.FATAL);
    }
  });

  it('loads exact configured rules for hostile own JSON keys', () => {
    const rules = createHostileRuleMap(modelName => {
      const index = HOSTILE_MODEL_IDS.indexOf(modelName as typeof HOSTILE_MODEL_IDS[number]);
      return {
        ...DEFAULT_THROTTLING_RULE,
        Short_limit_request_cap: index + 1,
        Long_limit_request_cap: index + 11
      };
    });
    const fixture = writeRawLimitsFile(JSON.stringify({ models: rules }));

    try {
      const tracker = new RateLimitTracker(fixture.limitsPath);
      for (const modelName of HOSTILE_MODEL_IDS) {
        assert.deepStrictEqual(tracker.getLimitsForModel(modelName), rules[modelName], modelName);
      }
    } finally {
      removeLimitsFixture(fixture.directory);
    }
  });

  it('defines exact production rules for MiMo and OpenRouter while retaining the qualified MiMo key', () => {
    const productionLimitsPath = path.join(process.cwd(), 'config', 'throttling-limits.json');
    const productionLimits = JSON.parse(fs.readFileSync(productionLimitsPath, 'utf8')) as ThrottlingLimitsConfig;
    const mimoRule: ThrottlingRule = {
      Short_limit_duration_in_seconds: 60,
      Long_limit_duration_in_seconds: 86400,
      Short_limit_request_cap: 10,
      Long_limit_request_cap: 50,
      Short_limit_token_cap: 200000,
      Long_limit_token_cap: 1000000
    };

    assert.deepStrictEqual(productionLimits.models['mimo-v2.5'], mimoRule);
    assert.deepStrictEqual(productionLimits.models['xiaomi/mimo-v2.5'], mimoRule);
    assert.deepStrictEqual(productionLimits.models['openai/gpt-4o-mini'], DEFAULT_THROTTLING_RULE);
  });
});

describe('RateLimitTracker state persistence and safety', () => {
  let tempTrackerFile: string;

  before(() => {
    tempTrackerFile = process.env.RATE_LIMIT_TRACKER_PATH || path.join(os.tmpdir(), 'mcp-media-processing-rate-limits.json');
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

  it('uses null-prototype model maps for empty and loaded state', () => {
    const tracker = new RateLimitTracker();
    tracker.clearAll();
    assert.strictEqual(Object.getPrototypeOf(tracker.readState().models), null);

    tracker.recordAttempt('ordinary-model', 1);
    const freshTracker = new RateLimitTracker();
    const state = freshTracker.readState();
    assert.strictEqual(Object.getPrototypeOf(state.models), null);
    assert.ok(Object.hasOwn(state.models, 'ordinary-model'));
  });

  it('persists hostile model IDs as own entries and enforces their configured caps and cooldowns', () => {
    const fixture = writeRawLimitsFile(JSON.stringify({ models: createHostileRuleMap(() => createRuleWithShortRequestCap(1)) }));

    try {
      const tracker = new RateLimitTracker(fixture.limitsPath);
      for (const modelName of HOSTILE_MODEL_IDS) {
        tracker.clearAll();

        assert.strictEqual(tracker.isModelAvailable(modelName), true, modelName);
        tracker.markCooldown(modelName, 10000);
        assert.strictEqual(tracker.isModelAvailable(modelName), false, `${modelName} cooldown`);
        tracker.clearCooldown(modelName);
        assert.strictEqual(tracker.isModelAvailable(modelName), true, `${modelName} cleared cooldown`);

        tracker.recordAttempt(modelName, 1);
        assert.strictEqual(tracker.isModelAvailable(modelName), false, `${modelName} request cap`);

        const state = tracker.readState();
        assert.ok(Object.hasOwn(state.models, modelName), modelName);
        assert.strictEqual(state.models[modelName].cooldownUntil, 0, modelName);

        const persisted = JSON.parse(fs.readFileSync(tempTrackerFile, 'utf8')) as { models: Record<string, unknown> };
        assert.ok(Object.hasOwn(persisted.models, modelName), modelName);

        const freshTracker = new RateLimitTracker(fixture.limitsPath);
        const freshState = freshTracker.readState();
        assert.ok(Object.hasOwn(freshState.models, modelName), modelName);
        assert.strictEqual(freshTracker.isModelAvailable(modelName), false, `${modelName} after reread`);
      }
    } finally {
      removeLimitsFixture(fixture.directory);
    }
  });

  it('does not mutate Object or Object.prototype while handling hostile model IDs', () => {
    const objectDescriptors = snapshotOwnPropertyDescriptors(Object);
    const objectPrototypeDescriptors = snapshotOwnPropertyDescriptors(Object.prototype);
    const objectPrototypeToStringDescriptors = snapshotOwnPropertyDescriptors(Object.prototype.toString);

    try {
      const tracker = new RateLimitTracker();
      for (const modelName of HOSTILE_MODEL_IDS) {
        tracker.clearAll();
        tracker.getLimitsForModel(modelName);
        tracker.recordAttempt(modelName, 1);
        tracker.markCooldown(modelName, 10000);
        tracker.clearCooldown(modelName);
      }

      assertOwnPropertyDescriptorsEqual(Object, objectDescriptors);
      assertOwnPropertyDescriptorsEqual(Object.prototype, objectPrototypeDescriptors);
      assertOwnPropertyDescriptorsEqual(Object.prototype.toString, objectPrototypeToStringDescriptors);
    } finally {
      restoreOwnPropertyDescriptors(Object, objectDescriptors);
      restoreOwnPropertyDescriptors(Object.prototype, objectPrototypeDescriptors);
      restoreOwnPropertyDescriptors(Object.prototype.toString, objectPrototypeToStringDescriptors);
    }
  });

  it('rejects null and array model maps and recovers to durable hostile-key state', () => {
    for (const malformedModels of [null, []]) {
      const fixture = writeRawLimitsFile(JSON.stringify({ models: malformedModels }));

      try {
        const tracker = new RateLimitTracker(fixture.limitsPath);
        assert.deepStrictEqual(tracker.getLimitsForModel('__proto__'), DEFAULT_THROTTLING_RULE);

        fs.writeFileSync(tempTrackerFile, JSON.stringify({ models: malformedModels }), 'utf8');
        const emptyState = tracker.readState();
        assert.strictEqual(Object.getPrototypeOf(emptyState.models), null);
        assert.deepStrictEqual(Object.keys(emptyState.models), []);

        tracker.recordAttempt('__proto__', 1);
        assert.ok(Object.hasOwn(tracker.readState().models, '__proto__'));

        const freshTracker = new RateLimitTracker(fixture.limitsPath);
        assert.ok(Object.hasOwn(freshTracker.readState().models, '__proto__'));
      } finally {
        removeLimitsFixture(fixture.directory);
      }
    }
  });

  it('loads, enforces, updates, and serializes conventional legacy state unchanged', () => {
    const modelName = 'legacy-model';
    const rule = createRuleWithShortRequestCap(2);
    const fixture = writeCustomLimitsFile({ [modelName]: rule });
    const timestamp = Date.now();

    try {
      fs.writeFileSync(tempTrackerFile, JSON.stringify({
        models: {
          [modelName]: {
            shortRequestTimestamps: [{ timestamp, tokens: 1 }],
            longRequestTimestamps: [{ timestamp, tokens: 1 }],
            cooldownUntil: 0
          }
        }
      }), 'utf8');

      const tracker = new RateLimitTracker(fixture.limitsPath);
      const loaded = tracker.readState();
      assert.strictEqual(Object.getPrototypeOf(loaded.models), null);
      assert.ok(Object.hasOwn(loaded.models, modelName));
      assert.strictEqual(tracker.isModelAvailable(modelName), true);

      tracker.recordAttempt(modelName, 1);
      assert.strictEqual(tracker.isModelAvailable(modelName), false);

      const serialized = JSON.parse(fs.readFileSync(tempTrackerFile, 'utf8')) as { models: Record<string, ModelRateState> };
      assert.deepStrictEqual(Object.keys(serialized), ['models']);
      assert.deepStrictEqual(Object.keys(serialized.models), [modelName]);
      assert.strictEqual(serialized.models[modelName].shortRequestTimestamps.length, 2);
      assert.strictEqual(serialized.models[modelName].longRequestTimestamps.length, 2);
    } finally {
      removeLimitsFixture(fixture.directory);
    }
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

  it('does not classify message-only EPIPE as retryable', () => {
    const c = classifyOpenAiError('write EPIPE');
    assert.strictEqual(c.retryable, false);
  });

  it('does not classify message-only EHOSTUNREACH as retryable', () => {
    const c = classifyOpenAiError('connect EHOSTUNREACH');
    assert.strictEqual(c.retryable, false);
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
    assert.strictEqual(classifyOpenAiError('OpenRouter API error (422): fetch failed, HTTP 429, EPIPE').retryable, false);
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

  function makeOpenRouterMimoFallbackConfig() {
    return {
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
  }

  function makeRateLimitedGeminiService(): GeminiServiceMock {
    return {
      uploadFile: async () => sampleFile,
      processFile: async () => {
        throw Object.assign(new Error('Quota limit hit'), { name: 'ApiError', status: 429 });
      },
      processText: async () => {
        throw Object.assign(new Error('Quota limit hit'), { name: 'ApiError', status: 429 });
      }
    };
  }

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

  for (const testCase of [
    {
      name: 'top-level EPIPE',
      error: Object.assign(new Error('provider text must not prove the transport code'), { code: 'EPIPE' }),
      reason: 'broken pipe'
    },
    {
      name: 'nested EHOSTUNREACH under an unrecognized wrapper',
      error: {
        code: 'WRAPPER_FAILURE',
        cause: { code: 'EHOSTUNREACH' }
      },
      reason: 'host unreachable'
    }
  ]) {
    it(`routes from OpenRouter to MiMo for a genuine fetch failure with ${testCase.name}`, async () => {
      const originalFetch = global.fetch;
      const originalConsoleError = console.error;
      const warnings: string[] = [];
      const fetchCalls: { url: string; model: string }[] = [];
      Logger.setLogLevel(LogLevel.WARN);
      console.error = (...args: unknown[]): void => {
        warnings.push(args.map(String).join(' '));
      };
      global.fetch = async (url, init): Promise<Response> => {
        const urlText = String(url);
        const body = parseRequestBody(init);
        fetchCalls.push({ url: urlText, model: body.model });

        if (urlText.includes('openrouter.ai')) {
          throw testCase.error;
        }
        if (urlText.includes('xiaomimimo.com')) {
          return chatCompletionResponse('MiMo recovered from structured transport failure.');
        }
        throw new Error(`Unexpected fetch URL: ${urlText}`);
      };

      try {
        const provider = new GeminiRecognitionProvider(
          makeOpenRouterMimoFallbackConfig(),
          asGeminiService(makeRateLimitedGeminiService())
        );
        const result = await provider.recognize({ ...baseRequest, filepath: testImagePath });

        assert.strictEqual(result.isError, undefined);
        assert.strictEqual(result.text, 'MiMo recovered from structured transport failure.');
        assert.deepStrictEqual(fetchCalls, [
          { url: 'https://openrouter.ai/api/v1/chat/completions', model: 'google/gemini-2.5-flash' },
          { url: 'https://api.xiaomimimo.com/v1/chat/completions', model: 'mimo-v2.5' }
        ]);
        assert.ok(warnings.some(message => message.includes(`OpenRouter model google/gemini-2.5-flash failed: ${testCase.reason}`)));
      } finally {
        console.error = originalConsoleError;
        Logger.setLogLevel(LogLevel.FATAL);
        global.fetch = originalFetch;
      }
    });
  }

  for (const testCase of [
    { status: 400, statusText: 'Bad Request' },
    { status: 422, statusText: 'Unprocessable Content' }
  ]) {
    it(`does not route to MiMo when OpenRouter returns ${testCase.status} with misleading provider body text`, async () => {
      const originalFetch = global.fetch;
      const fetchCalls: { url: string; model: string; body: CapturedRequestBody }[] = [];
      global.fetch = async (url, init): Promise<Response> => {
        const urlText = String(url);
        const body = parseRequestBody(init);
        fetchCalls.push({ url: urlText, model: body.model, body });

        if (urlText.includes('openrouter.ai')) {
          return chatCompletionResponse(
            JSON.stringify({ error: { message: 'EPIPE EHOSTUNREACH fetch failed HTTP 429 HTTP 503' } }),
            testCase.status,
            testCase.statusText
          );
        }
        throw new Error(`Unexpected later provider request: ${urlText}`);
      };

      try {
        const provider = new GeminiRecognitionProvider(
          makeOpenRouterMimoFallbackConfig(),
          asGeminiService(makeRateLimitedGeminiService())
        );
        const result = await provider.recognize({ ...baseRequest, filepath: testImagePath });

        assert.strictEqual(result.isError, true);
        assert.deepStrictEqual(fetchCalls.map(call => ({ url: call.url, model: call.model })), [
          { url: 'https://openrouter.ai/api/v1/chat/completions', model: 'google/gemini-2.5-flash' }
        ]);
        assert.strictEqual(fetchCalls.length, 1, 'No later provider body, media, or prompt should be sent.');
      } finally {
        global.fetch = originalFetch;
      }
    });
  }

  it('routes to MiMo for HTTP 429 even when the provider body contains fail-fast and EPIPE text', async () => {
    const originalFetch = global.fetch;
    const fetchCalls: { url: string; model: string }[] = [];
    global.fetch = async (url, init): Promise<Response> => {
      const urlText = String(url);
      const body = parseRequestBody(init);
      fetchCalls.push({ url: urlText, model: body.model });

      if (urlText.includes('openrouter.ai')) {
        return chatCompletionResponse(
          JSON.stringify({ error: { message: 'invalid request unsupported media EPIPE' } }),
          429,
          'Too Many Requests'
        );
      }
      if (urlText.includes('xiaomimimo.com')) {
        return chatCompletionResponse('MiMo recovered from HTTP 429.');
      }
      throw new Error(`Unexpected fetch URL: ${urlText}`);
    };

    try {
      const provider = new GeminiRecognitionProvider(
        makeOpenRouterMimoFallbackConfig(),
        asGeminiService(makeRateLimitedGeminiService())
      );
      const result = await provider.recognize({ ...baseRequest, filepath: testImagePath });

      assert.strictEqual(result.isError, undefined);
      assert.strictEqual(result.text, 'MiMo recovered from HTTP 429.');
      assert.deepStrictEqual(fetchCalls, [
        { url: 'https://openrouter.ai/api/v1/chat/completions', model: 'google/gemini-2.5-flash' },
        { url: 'https://api.xiaomimimo.com/v1/chat/completions', model: 'mimo-v2.5' }
      ]);
    } finally {
      global.fetch = originalFetch;
    }
  });

  for (const testCase of [
    { status: 422, expectedMiMoCall: false },
    { status: 200, expectedMiMoCall: true }
  ]) {
    it(`uses ${testCase.status} status instead of a response-read EPIPE when deciding whether to route to MiMo`, async () => {
      const originalFetch = global.fetch;
      const fetchCalls: { url: string; model: string }[] = [];
      const responseReadError = Object.assign(new Error('provider-controlled text is unavailable'), { code: 'EPIPE' });
      global.fetch = async (url, init): Promise<Response> => {
        const urlText = String(url);
        const body = parseRequestBody(init);
        fetchCalls.push({ url: urlText, model: body.model });

        if (urlText.includes('openrouter.ai')) {
          return {
            ok: testCase.status >= 200 && testCase.status < 300,
            status: testCase.status,
            statusText: 'Test Status',
            text: async (): Promise<string> => {
              throw responseReadError;
            }
          } as Response;
        }
        if (urlText.includes('xiaomimimo.com')) {
          return chatCompletionResponse('MiMo recovered from readable-status transport failure.');
        }
        throw new Error(`Unexpected fetch URL: ${urlText}`);
      };

      try {
        const provider = new GeminiRecognitionProvider(
          makeOpenRouterMimoFallbackConfig(),
          asGeminiService(makeRateLimitedGeminiService())
        );
        const result = await provider.recognize({ ...baseRequest, filepath: testImagePath });

        assert.strictEqual(result.isError, testCase.expectedMiMoCall ? undefined : true);
        assert.strictEqual(fetchCalls.filter(call => call.url.includes('xiaomimimo.com')).length, testCase.expectedMiMoCall ? 1 : 0);
      } finally {
        global.fetch = originalFetch;
      }
    });
  }

  for (const testCase of [
    {
      name: 'a cyclic cause chain',
      error: (() => {
        const cycle: { code: string; cause?: unknown } = { code: 'WRAPPER_FAILURE' };
        cycle.cause = cycle;
        return cycle;
      })()
    },
    {
      name: 'a recognized code beyond the eight-node bound',
      error: (() => {
        const head: { code: string; cause?: unknown } = { code: 'WRAPPER_FAILURE' };
        let current = head;
        for (let index = 0; index < 8; index += 1) {
          const next: { code: string; cause?: unknown } = { code: 'WRAPPER_FAILURE' };
          current.cause = next;
          current = next;
        }
        current.code = 'EPIPE';
        return head;
      })()
    }
  ]) {
    it(`uses generic retryable transport handling for ${testCase.name}`, async () => {
      const originalFetch = global.fetch;
      const originalConsoleError = console.error;
      const warnings: string[] = [];
      Logger.setLogLevel(LogLevel.WARN);
      console.error = (...args: unknown[]): void => {
        warnings.push(args.map(String).join(' '));
      };
      global.fetch = async (url): Promise<Response> => {
        const urlText = String(url);
        if (urlText.includes('openrouter.ai')) {
          throw testCase.error;
        }
        if (urlText.includes('xiaomimimo.com')) {
          return chatCompletionResponse('MiMo recovered from generic transport failure.');
        }
        throw new Error(`Unexpected fetch URL: ${urlText}`);
      };

      try {
        const provider = new GeminiRecognitionProvider(
          makeOpenRouterMimoFallbackConfig(),
          asGeminiService(makeRateLimitedGeminiService())
        );
        const result = await provider.recognize({ ...baseRequest, filepath: testImagePath });

        assert.strictEqual(result.isError, undefined);
        assert.strictEqual(result.text, 'MiMo recovered from generic transport failure.');
        assert.ok(warnings.some(message => message.includes('OpenRouter model google/gemini-2.5-flash failed: transient network failure')));
      } finally {
        console.error = originalConsoleError;
        Logger.setLogLevel(LogLevel.FATAL);
        global.fetch = originalFetch;
      }
    });
  }

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

function writeCustomLimitsFile(models: Record<string, ThrottlingRule>): { directory: string; limitsPath: string } {
  return writeRawLimitsFile(JSON.stringify({ models }));
}

function writeRawLimitsFile(rawLimits: string): { directory: string; limitsPath: string } {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-routing-limits-test-'));
  const limitsPath = path.join(directory, 'throttling-limits.json');
  fs.writeFileSync(limitsPath, rawLimits, 'utf8');
  return { directory, limitsPath };
}

function removeLimitsFixture(directory: string): void {
  fs.rmSync(directory, { recursive: true, force: true });
}

function createHostileRuleMap(createRule: (modelName: typeof HOSTILE_MODEL_IDS[number]) => ThrottlingRule): Record<string, ThrottlingRule> {
  const rules = Object.create(null) as Record<string, ThrottlingRule>;
  for (const modelName of HOSTILE_MODEL_IDS) {
    rules[modelName] = createRule(modelName);
  }
  return rules;
}

function createRuleWithShortRequestCap(shortRequestCap: number): ThrottlingRule {
  return {
    ...DEFAULT_THROTTLING_RULE,
    Short_limit_request_cap: shortRequestCap
  };
}

function snapshotOwnPropertyDescriptors(target: object): Map<PropertyKey, PropertyDescriptor> {
  return new Map(
    Reflect.ownKeys(target).map(key => [key, Object.getOwnPropertyDescriptor(target, key) as PropertyDescriptor])
  );
}

function assertOwnPropertyDescriptorsEqual(target: object, expected: Map<PropertyKey, PropertyDescriptor>): void {
  const actual = snapshotOwnPropertyDescriptors(target);
  assert.strictEqual(actual.size, expected.size);
  for (const [key, descriptor] of expected) {
    assert.deepStrictEqual(actual.get(key), descriptor, String(key));
  }
}

function restoreOwnPropertyDescriptors(target: object, expected: Map<PropertyKey, PropertyDescriptor>): void {
  for (const key of Reflect.ownKeys(target)) {
    if (!expected.has(key)) {
      Reflect.deleteProperty(target, key);
    }
  }
  for (const [key, descriptor] of expected) {
    Object.defineProperty(target, key, descriptor);
  }
}
