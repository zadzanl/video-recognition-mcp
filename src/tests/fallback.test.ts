/**
 * Tests for Gemini error classification and model fallback execution.
 *
 * status: ACTIVE
 * phase: MVP
 * sprint: unknown
 * last_modified: 2026-06-19
 * agent_notes: "Tests for classifyGeminiError and GeminiRecognitionProvider fallback loop."
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { classifyGeminiError } from '../services/gemini-error-classifier.js';
import type { ErrorClassification } from '../services/gemini-error-classifier.js';
import type {
  GeminiRecognitionConfig,
  GeminiFile,
  GeminiResponse,
  RecognitionRequest,
  RecognitionResult
} from '../types/index.js';

// ---------------------------------------------------------------------------
// classifyGeminiError — retryable / fallback-eligible
// ---------------------------------------------------------------------------

describe('classifyGeminiError retryable', () => {
  it('classifies 429 as retryable', () => {
    const c = classifyGeminiError({ name: 'ApiError', message: 'Too many requests', status: 429 });
    assert.strictEqual(c.retryable, true);
    assert.ok(c.reason.includes('429'));
  });

  it('classifies 500 as retryable', () => {
    const c = classifyGeminiError({ name: 'ApiError', message: 'Internal error', status: 500 });
    assert.strictEqual(c.retryable, true);
    assert.ok(c.reason.includes('internal error'));
  });

  it('classifies 503 as retryable', () => {
    const c = classifyGeminiError({ name: 'ApiError', message: 'Unavailable', status: 503 });
    assert.strictEqual(c.retryable, true);
    assert.ok(c.reason.includes('service unavailable'));
  });

  it('classifies RESOURCE_EXHAUSTED in message as retryable', () => {
    const c = classifyGeminiError({ name: 'ApiError', message: 'RESOURCE_EXHAUSTED: quota exceeded', status: 429 });
    assert.strictEqual(c.retryable, true);
  });

  it('classifies INTERNAL in name as retryable', () => {
    const c = classifyGeminiError({ name: 'INTERNAL', message: 'something broke', status: 500 });
    assert.strictEqual(c.retryable, true);
  });

  it('classifies UNAVAILABLE in message as retryable', () => {
    const c = classifyGeminiError({ name: 'ApiError', message: 'Service UNAVAILABLE', status: 503 });
    assert.strictEqual(c.retryable, true);
  });

  it('classifies DEADLINE_EXCEEDED in name as retryable', () => {
    const c = classifyGeminiError({ name: 'DEADLINE_EXCEEDED', message: 'Request timed out' });
    assert.strictEqual(c.retryable, true);
    assert.ok(c.reason.includes('deadline exceeded'));
  });

  it('classifies ETIMEDOUT in cause as retryable', () => {
    const err = new Error('connect ETIMEDOUT');
    (err as any).cause = 'ETIMEDOUT';
    const c = classifyGeminiError(err);
    assert.strictEqual(c.retryable, true);
  });

  it('classifies ECONNRESET as retryable', () => {
    const err = new Error('read ECONNRESET');
    const c = classifyGeminiError(err);
    assert.strictEqual(c.retryable, true);
  });

  it('classifies EAI_AGAIN as retryable', () => {
    const err = new Error('getaddrinfo EAI_AGAIN');
    const c = classifyGeminiError(err);
    assert.strictEqual(c.retryable, true);
  });

  it('classifies TIMEOUT in message as retryable', () => {
    const err = new Error('Request timeout');
    const c = classifyGeminiError(err);
    assert.strictEqual(c.retryable, true);
  });

  it('classifies ABORT_ERR as retryable', () => {
    const err = new Error('The operation was aborted');
    err.name = 'AbortError';
    const c = classifyGeminiError(err);
    assert.strictEqual(c.retryable, true);
  });
});

// ---------------------------------------------------------------------------
// classifyGeminiError — fail-fast
// ---------------------------------------------------------------------------

describe('classifyGeminiError fail-fast', () => {
  it('classifies 401 as fail-fast', () => {
    const c = classifyGeminiError({ name: 'ApiError', message: 'Unauthorized', status: 401 });
    assert.strictEqual(c.retryable, false);
    assert.ok(c.reason.includes('401'));
  });

  it('classifies 402 as fail-fast', () => {
    const c = classifyGeminiError({ name: 'ApiError', message: 'Payment Required', status: 402 });
    assert.strictEqual(c.retryable, false);
    assert.ok(c.reason.includes('402'));
  });

  it('classifies 403 as fail-fast', () => {
    const c = classifyGeminiError({ name: 'ApiError', message: 'Forbidden', status: 403 });
    assert.strictEqual(c.retryable, false);
    assert.ok(c.reason.includes('forbidden'));
  });

  it('classifies 403 with PERMISSION_DENIED text as fail-fast with permission reason', () => {
    const c = classifyGeminiError({ name: 'ApiError', message: 'PERMISSION_DENIED: access denied', status: 403 });
    assert.strictEqual(c.retryable, false);
    assert.ok(c.reason.includes('permission denied'));
  });

  it('classifies 403 with BILLING text as fail-fast with billing reason', () => {
    const c = classifyGeminiError({ name: 'ApiError', message: 'BILLING account not active', status: 403 });
    assert.strictEqual(c.retryable, false);
    assert.ok(c.reason.includes('billing/account'));
  });

  it('classifies 403 with FAILED_PRECONDITION text as fail-fast with precondition reason', () => {
    const c = classifyGeminiError({ name: 'ApiError', message: 'FAILED_PRECONDITION: account setup required', status: 403 });
    assert.strictEqual(c.retryable, false);
    assert.ok(c.reason.includes('precondition/account'));
  });

  it('classifies 400 as fail-fast', () => {
    const c = classifyGeminiError({ name: 'ApiError', message: 'Bad request', status: 400 });
    assert.strictEqual(c.retryable, false);
    assert.ok(c.reason.includes('400'));
  });

  it('classifies PERMISSION_DENIED as fail-fast', () => {
    const c = classifyGeminiError({ name: 'PERMISSION_DENIED', message: 'Not allowed' });
    assert.strictEqual(c.retryable, false);
  });

  it('classifies UNAUTHENTICATED as fail-fast', () => {
    const c = classifyGeminiError({ name: 'UNAUTHENTICATED', message: 'Invalid key' });
    assert.strictEqual(c.retryable, false);
  });

  it('classifies BILLING in message as fail-fast', () => {
    const c = classifyGeminiError({ name: 'ApiError', message: 'BILLING account not active', status: 403 });
    assert.strictEqual(c.retryable, false);
  });

  it('classifies INVALID_ARGUMENT as fail-fast', () => {
    const c = classifyGeminiError({ name: 'INVALID_ARGUMENT', message: 'Bad input' });
    assert.strictEqual(c.retryable, false);
  });

  it('classifies FAILED_PRECONDITION as fail-fast', () => {
    const c = classifyGeminiError({ name: 'FAILED_PRECONDITION', message: 'Account not ready' });
    assert.strictEqual(c.retryable, false);
  });

  it('classifies generic Error as fail-fast', () => {
    const c = classifyGeminiError(new Error('Something unusual happened'));
    assert.strictEqual(c.retryable, false);
  });

  it('classifies unknown throw as fail-fast', () => {
    const c = classifyGeminiError('some string error');
    assert.strictEqual(c.retryable, false);
    assert.strictEqual(c.reason, 'unknown error');
  });

  it('classifies null as fail-fast', () => {
    const c = classifyGeminiError(null);
    assert.strictEqual(c.retryable, false);
    assert.strictEqual(c.reason, 'unknown error');
  });

  it('classifies unknown API status >= 400 as fail-fast', () => {
    const c = classifyGeminiError({ name: 'ApiError', message: 'Something', status: 418 });
    assert.strictEqual(c.retryable, false);
    assert.ok(c.reason.includes('418'));
  });

  // String status / code field coverage
  it('classifies numeric code 429 as retryable', () => {
    const c = classifyGeminiError({ name: 'ApiError', code: 429 });
    assert.strictEqual(c.retryable, true);
    assert.ok(c.reason.includes('429'));
  });

  it('classifies string code RESOURCE_EXHAUSTED as retryable', () => {
    const c = classifyGeminiError({ code: 'RESOURCE_EXHAUSTED' });
    assert.strictEqual(c.retryable, true);
    assert.ok(c.reason.includes('resource exhausted'));
  });

  it('classifies string status UNAVAILABLE as retryable', () => {
    const c = classifyGeminiError({ status: 'UNAVAILABLE' });
    assert.strictEqual(c.retryable, true);
    assert.ok(c.reason.includes('service unavailable'));
  });

  it('classifies string status INTERNAL as retryable', () => {
    const c = classifyGeminiError({ status: 'INTERNAL' });
    assert.strictEqual(c.retryable, true);
    assert.ok(c.reason.includes('internal error'));
  });

  it('classifies string code DEADLINE_EXCEEDED as retryable', () => {
    const c = classifyGeminiError({ code: 'DEADLINE_EXCEEDED' });
    assert.strictEqual(c.retryable, true);
    assert.ok(c.reason.includes('deadline exceeded'));
  });

  it('classifies string code PERMISSION_DENIED as fail-fast', () => {
    const c = classifyGeminiError({ code: 'PERMISSION_DENIED' });
    assert.strictEqual(c.retryable, false);
    assert.ok(c.reason.includes('permission denied'));
  });
});

// ---------------------------------------------------------------------------
// Fallback loop integration tests
// ---------------------------------------------------------------------------
// These tests create a real temporary .png file so validateMediaFile passes,
// then inject a mock GeminiService to control generation outcomes.
// This avoids real Gemini API calls.

import { GeminiRecognitionProvider } from '../services/recognition-providers.js';

const sampleFileUri = 'gs://test-bucket/test-file';
const sampleFile: GeminiFile = {
  uri: sampleFileUri,
  mimeType: 'image/png',
  name: 'test-file',
  state: 'ACTIVE'
};

function makeConfig(modelNames: string[]): GeminiRecognitionConfig {
  return {
    provider: 'gemini',
    providerLabel: 'Google Gemini',
    modelName: modelNames.length === 1 ? modelNames[0] : `${modelNames[0]} + ${modelNames.length - 1} fallback`,
    modelNames,
    apiKey: 'test-key'
  };
}

function successResponse(modelName: string): GeminiResponse {
  return { text: `Success from ${modelName}` };
}

function throwTransient(message: string): never {
  throw Object.assign(new Error(message), { name: 'ApiError', status: 503 });
}

function throwAuthError(): never {
  throw Object.assign(new Error('Invalid API key'), { name: 'UNAUTHENTICATED', status: 401 });
}

function throwHttpError(status: number, message: string): never {
  throw Object.assign(new Error(message), { name: 'ApiError', status });
}

describe('GeminiRecognitionProvider fallback loop', () => {
  let tmpDir: string;
  let testImagePath: string;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gemini-fallback-test-'));
    testImagePath = path.join(tmpDir, 'test-image.png');
    // Create a minimal valid PNG file (1x1 pixel).
    const minimalPng = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
      'base64'
    );
    fs.writeFileSync(testImagePath, minimalPng);
  });

  after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const baseRequest: RecognitionRequest = {
    filepath: '', // set per test
    prompt: 'Describe this',
    mediaKind: 'image'
  };

  it('succeeds on primary model without trying fallbacks', async () => {
    const processCalls: string[] = [];
    const mockService = {
      uploadFile: async (_p: string): Promise<GeminiFile> => sampleFile,
      processFile: async (_f: GeminiFile, _prompt: string, modelName: string): Promise<GeminiResponse> => {
        processCalls.push(modelName);
        return successResponse(modelName);
      }
    };

    const config = makeConfig(['gemini-3.5-flash', 'gemini-2.5-flash', 'gemini-lite']);
    const provider = new GeminiRecognitionProvider(config, mockService as any);
    const result = await provider.recognize({ ...baseRequest, filepath: testImagePath });

    assert.strictEqual(result.isError, undefined);
    assert.strictEqual(result.text, 'Success from gemini-3.5-flash');
    assert.deepStrictEqual(processCalls, ['gemini-3.5-flash']);
  });

  it('falls back to second model when first fails with retryable error', async () => {
    const processCalls: string[] = [];
    const mockService = {
      uploadFile: async (_p: string): Promise<GeminiFile> => sampleFile,
      processFile: async (_f: GeminiFile, _prompt: string, modelName: string): Promise<GeminiResponse> => {
        processCalls.push(modelName);
        if (modelName === 'gemini-3.5-flash') {
          throwTransient('Service unavailable');
        }
        return successResponse(modelName);
      }
    };

    const config = makeConfig(['gemini-3.5-flash', 'gemini-2.5-flash', 'gemini-lite']);
    const provider = new GeminiRecognitionProvider(config, mockService as any);
    const result = await provider.recognize({ ...baseRequest, filepath: testImagePath });

    assert.strictEqual(result.isError, undefined);
    assert.strictEqual(result.text, 'Success from gemini-2.5-flash');
    assert.deepStrictEqual(processCalls, ['gemini-3.5-flash', 'gemini-2.5-flash']);
  });

  it('continues fallback chain through multiple retryable failures', async () => {
    const processCalls: string[] = [];
    const mockService = {
      uploadFile: async (_p: string): Promise<GeminiFile> => sampleFile,
      processFile: async (_f: GeminiFile, _prompt: string, modelName: string): Promise<GeminiResponse> => {
        processCalls.push(modelName);
        if (modelName === 'gemini-3.5-flash' || modelName === 'gemini-2.5-flash') {
          throwTransient('Service unavailable');
        }
        return successResponse(modelName);
      }
    };

    const config = makeConfig(['gemini-3.5-flash', 'gemini-2.5-flash', 'gemini-lite']);
    const provider = new GeminiRecognitionProvider(config, mockService as any);
    const result = await provider.recognize({ ...baseRequest, filepath: testImagePath });

    assert.strictEqual(result.isError, undefined);
    assert.strictEqual(result.text, 'Success from gemini-lite');
    assert.deepStrictEqual(processCalls, ['gemini-3.5-flash', 'gemini-2.5-flash', 'gemini-lite']);
  });

  it('returns exhaustion error when all models fail with retryable errors', async () => {
    const mockService = {
      uploadFile: async (_p: string): Promise<GeminiFile> => sampleFile,
      processFile: async (_f: GeminiFile, _prompt: string, _modelName: string): Promise<GeminiResponse> => {
        throwTransient('Service unavailable');
      }
    };

    const config = makeConfig(['gemini-3.5-flash', 'gemini-2.5-flash']);
    const provider = new GeminiRecognitionProvider(config, mockService as any);
    const result = await provider.recognize({ ...baseRequest, filepath: testImagePath });

    assert.strictEqual(result.isError, true);
    assert.ok(result.text.includes('Gemini model fallback exhausted'));
    assert.ok(result.text.includes('gemini-3.5-flash'));
    assert.ok(result.text.includes('gemini-2.5-flash'));
    assert.ok(result.text.includes('service unavailable'));
  });

  it('fail-fast on auth error stops fallback immediately', async () => {
    const processCalls: string[] = [];
    const mockService = {
      uploadFile: async (_p: string): Promise<GeminiFile> => sampleFile,
      processFile: async (_f: GeminiFile, _prompt: string, modelName: string): Promise<GeminiResponse> => {
        processCalls.push(modelName);
        throwAuthError();
      }
    };

    const config = makeConfig(['gemini-3.5-flash', 'gemini-2.5-flash', 'gemini-lite']);
    const provider = new GeminiRecognitionProvider(config, mockService as any);
    const result = await provider.recognize({ ...baseRequest, filepath: testImagePath });

    assert.strictEqual(result.isError, true);
    assert.ok(result.text.includes('Gemini generation failed'));
    assert.ok(result.text.includes('unauthenticated'));
    // Only the first model should have been attempted.
    assert.deepStrictEqual(processCalls, ['gemini-3.5-flash']);
  });

  it('fail-fast on 400 error stops fallback immediately', async () => {
    const processCalls: string[] = [];
    const mockService = {
      uploadFile: async (_p: string): Promise<GeminiFile> => sampleFile,
      processFile: async (_f: GeminiFile, _prompt: string, modelName: string): Promise<GeminiResponse> => {
        processCalls.push(modelName);
        throwHttpError(400, 'Bad request');
      }
    };

    const config = makeConfig(['gemini-3.5-flash', 'gemini-2.5-flash']);
    const provider = new GeminiRecognitionProvider(config, mockService as any);
    const result = await provider.recognize({ ...baseRequest, filepath: testImagePath });

    assert.strictEqual(result.isError, true);
    assert.ok(result.text.includes('400'));
    assert.deepStrictEqual(processCalls, ['gemini-3.5-flash']);
  });

  it('uploads file only once across multiple fallback attempts', async () => {
    let uploadCount = 0;
    const processCalls: string[] = [];
    const mockService = {
      uploadFile: async (_p: string): Promise<GeminiFile> => {
        uploadCount++;
        return sampleFile;
      },
      processFile: async (_f: GeminiFile, _prompt: string, modelName: string): Promise<GeminiResponse> => {
        processCalls.push(modelName);
        if (modelName === 'gemini-3.5-flash') {
          throwTransient('Unavailable');
        }
        return successResponse(modelName);
      }
    };

    const config = makeConfig(['gemini-3.5-flash', 'gemini-2.5-flash', 'gemini-lite']);
    const provider = new GeminiRecognitionProvider(config, mockService as any);
    await provider.recognize({ ...baseRequest, filepath: testImagePath });

    assert.strictEqual(uploadCount, 1);
    assert.deepStrictEqual(processCalls, ['gemini-3.5-flash', 'gemini-2.5-flash']);
  });

  it('single-model config works (no fallback models to try)', async () => {
    const mockService = {
      uploadFile: async (_p: string): Promise<GeminiFile> => sampleFile,
      processFile: async (_f: GeminiFile, _prompt: string, _modelName: string): Promise<GeminiResponse> => {
        throwTransient('Unavailable');
      }
    };

    const config = makeConfig(['gemini-3.5-flash']);
    const provider = new GeminiRecognitionProvider(config, mockService as any);
    const result = await provider.recognize({ ...baseRequest, filepath: testImagePath });

    assert.strictEqual(result.isError, true);
    assert.ok(result.text.includes('Gemini model fallback exhausted'));
    assert.ok(result.text.includes('gemini-3.5-flash'));
  });

  it('returns configuration error when modelNames is empty without calling uploadFile', async () => {
    let uploadCalled = false;
    const mockService = {
      uploadFile: async (_p: string): Promise<GeminiFile> => {
        uploadCalled = true;
        return sampleFile;
      },
      processFile: async (_f: GeminiFile, _prompt: string, _modelName: string): Promise<GeminiResponse> => {
        return successResponse('unreachable');
      }
    };

    const config = makeConfig([]);
    const provider = new GeminiRecognitionProvider(config, mockService as any);
    const result = await provider.recognize({ ...baseRequest, filepath: testImagePath });

    assert.strictEqual(result.isError, true);
    assert.ok(result.text.includes('configuration error'));
    assert.ok(result.text.includes('no model names'));
    assert.strictEqual(uploadCalled, false);
  });

  it('exhaustion message includes compact reasons for each attempted model', async () => {
    let callIdx = 0;
    const errors = [
      { status: 429, message: 'Rate limited' },
      { status: 503, message: 'Service unavailable' },
      { status: 500, message: 'Internal error' }
    ];
    const mockService = {
      uploadFile: async (_p: string): Promise<GeminiFile> => sampleFile,
      processFile: async (_f: GeminiFile, _prompt: string, _modelName: string): Promise<GeminiResponse> => {
        const err = errors[callIdx++];
        throw Object.assign(new Error(err.message), { name: 'ApiError', status: err.status });
      }
    };

    const config = makeConfig(['m1', 'm2', 'm3']);
    const provider = new GeminiRecognitionProvider(config, mockService as any);
    const result = await provider.recognize({ ...baseRequest, filepath: testImagePath });

    assert.strictEqual(result.isError, true);
    assert.ok(result.text.includes('m1'));
    assert.ok(result.text.includes('m2'));
    assert.ok(result.text.includes('m3'));
    assert.ok(result.text.includes('429'));
    assert.ok(result.text.includes('service unavailable'));
    assert.ok(result.text.includes('internal error'));
  });
});
