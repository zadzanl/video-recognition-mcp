/**
 * status: active
 * phase: checkpoint-4-gemini-adapter
 * sprint: provider-foundation-first-sprint
 * last_modified: 2026-08-03
 * agent_notes: "Credential-free direct tests for Gemini throwing/wrapper seams and timeout identity."
 * insights: "A negative explicit wait bound exercises timeout ownership without a real delay."
 */

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import {
  GeminiService,
  GeminiVideoProcessingTimeoutError
} from '../services/gemini.js';
import { DEFAULT_GEMINI_MODEL } from '../services/provider-config.js';
import { FileState, type GeminiFile } from '../types/index.js';

interface GenerateContentClient {
  models: {
    generateContent: (input: unknown) => Promise<{ text?: string }>;
  };
}

const file: GeminiFile = {
  uri: 'gemini://fixture',
  mimeType: 'image/png',
  name: 'fixture'
};

const serviceWithClient = (client: GenerateContentClient): GeminiService => {
  const service = new GeminiService({ apiKey: 'credential-free-test-key' });
  (service as unknown as { client: GenerateContentClient }).client = client;
  return service;
};

test('processFileOrThrow performs one generation and returns exact text', async () => {
  const calls: unknown[] = [];
  const service = serviceWithClient({
    models: {
      generateContent: async input => {
        calls.push(input);
        return { text: 'exact Gemini text' };
      }
    }
  });

  assert.deepEqual(await service.processFileOrThrow(file, 'prompt', 'explicit-model'), {
    text: 'exact Gemini text'
  });
  assert.equal(calls.length, 1);
  assert.equal((calls[0] as { model: string }).model, 'explicit-model');
});

test('processFileOrThrow propagates the exact original throw', async () => {
  const original = { message: 'upstream-sensitive', status: 429 };
  const service = serviceWithClient({
    models: { generateContent: async () => Promise.reject(original) }
  });

  await assert.rejects(service.processFileOrThrow(file, 'secret prompt', 'secret model'), error => {
    assert.equal(error, original);
    return true;
  });
});

test('processFile remains a delegating compatibility wrapper for success and errors', async () => {
  const service = serviceWithClient({
    models: { generateContent: async () => ({ text: 'unused' }) }
  });
  const calls: string[] = [];
  const original = new Error('original generation failure');
  service.processFileOrThrow = async (_file, _prompt, model) => {
    calls.push(model);
    if (calls.length === 1) return { text: 'wrapper success' };
    throw original;
  };

  assert.deepEqual(await service.processFile(file, 'prompt'), { text: 'wrapper success' });
  assert.deepEqual(await service.processFile(file, 'prompt', 'explicit-model'), {
    text: 'Error processing file: original generation failure',
    isError: true
  });
  assert.deepEqual(calls, [DEFAULT_GEMINI_MODEL, 'explicit-model']);
});

test('processFile preserves non-Error compatibility text', async () => {
  const service = serviceWithClient({
    models: { generateContent: async () => ({ text: 'unused' }) }
  });
  service.processFileOrThrow = async () => Promise.reject('string failure');
  assert.deepEqual(await service.processFile(file, 'prompt'), {
    text: 'Error processing file: string failure',
    isError: true
  });
});

test('waitForVideoProcessing throws the service-owned timeout identity immediately', async () => {
  const service = serviceWithClient({
    models: { generateContent: async () => ({ text: 'unused' }) }
  });
  const processingFile: GeminiFile = {
    ...file,
    state: FileState.PROCESSING
  };

  await assert.rejects(
    service.waitForVideoProcessing(processingFile, -1),
    GeminiVideoProcessingTimeoutError
  );
});

test('source preserves the 300000 default, polling delay, cache, and one generation implementation', async () => {
  const source = await readFile(path.resolve(process.cwd(), 'src/services/gemini.ts'), 'utf8');
  assert.match(source, /waitForVideoProcessing\(file: GeminiFile, maxWaitTimeMs = 300000\)/u);
  assert.match(source, /setTimeout\(resolve, 2000\)/u);
  assert.match(source, /private fileCache = new Map<string, CachedFile>\(\)/u);
  assert.equal((source.match(/\.models\.generateContent\(/gu) ?? []).length, 1);
  assert.match(source, /return await this\.processFileOrThrow\(/u);
});