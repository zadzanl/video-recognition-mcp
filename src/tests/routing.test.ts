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
import { GeminiRecognitionProvider } from '../services/recognition-providers.js';
import type { GeminiFile, GeminiResponse, RecognitionRequest } from '../types/index.js';

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
      processFile: async (_f: any, _p: any, model: string): Promise<GeminiResponse> => {
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
      rateLimitMaxWaitMs: 500
    };

    // We stub fetch to mock the OpenAI-compatible HTTP response from OpenRouter
    const originalFetch = global.fetch;
    let openRouterCalled = false;
    global.fetch = async (url, init): Promise<any> => {
      if (typeof url === 'string' && url.includes('openrouter.ai')) {
        openRouterCalled = true;
        const body = JSON.parse(init?.body as string);
        assert.strictEqual(body.model, 'google/gemini-2.5-flash');
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({
            choices: [{ message: { content: 'Success response from OpenRouter!' } }]
          })
        };
      }
      return originalFetch(url, init);
    };

    try {
      const provider = new GeminiRecognitionProvider(config, mockService as any);
      const result = await provider.recognize({ ...baseRequest, filepath: testImagePath });

      assert.strictEqual(result.isError, undefined);
      assert.strictEqual(result.text, 'Success response from OpenRouter!');
      assert.deepStrictEqual(processCalls, ['gemini-3.5-flash']);
      assert.strictEqual(openRouterCalled, true);
    } finally {
      global.fetch = originalFetch;
    }
  });

  it('fails fast on authentication error without attempting OpenRouter', async () => {
    const processCalls: string[] = [];
    const mockService = {
      uploadFile: async () => sampleFile,
      processFile: async (_f: any, _p: any, model: string): Promise<GeminiResponse> => {
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
      rateLimitMaxWaitMs: 500
    };

    const originalFetch = global.fetch;
    let openRouterCalled = false;
    global.fetch = async (url, init): Promise<any> => {
      if (typeof url === 'string' && url.includes('openrouter.ai')) {
        openRouterCalled = true;
      }
      return originalFetch(url, init);
    };

    try {
      const provider = new GeminiRecognitionProvider(config, mockService as any);
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
