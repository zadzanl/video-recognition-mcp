/**
 * status: active
 * phase: change-b-groups-4-5-recovery
 * sprint: gemini-model-fallback-and-rate-limit-recovery
 * last_modified: 2026-08-07
 * agent_notes: "Deterministic hostile-input and retry-timing matrix for the exact @google/genai 0.9.0 envelope boundary."
 * insights: "Only exact structured status/code and owned ADAPTER_TIMEOUT authorize fallback. Fixed-three-decimal direct retryDelay is diagnostic timing only."
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  GEMINI_ERROR_MESSAGE_MAX_BYTES,
  GEMINI_STRUCTURED_TRANSPORT_CAPABILITIES,
  classifyNormalizedGeminiFailure,
  normalizeGeminiGenerationFailure,
  type NormalizedGeminiFailure
} from '../services/gemini-error-classifier.js';
import { createProviderFailure } from '../services/provider-failure.js';
import type { ProviderFailureCategory } from '../types/provider.js';

const sdkError = (
  status: number,
  providerCode = status === 429 ? 'RESOURCE_EXHAUSTED' : 'UNAVAILABLE',
  extras: Record<string, unknown> = {}
): Error => {
  const error = new Error(`got status: ${status} Status Text. ${JSON.stringify({
    error: { code: status, status: providerCode, ...extras }
  })}`);
  error.name = status < 500 ? 'ClientError' : 'ServerError';
  return error;
};

const decision = (cause: unknown): string =>
  classifyNormalizedGeminiFailure(normalizeGeminiGenerationFailure(cause)).kind;

const normalized = (
  category: ProviderFailureCategory,
  details: { status?: number; code?: string; safeMessage?: string; cause?: unknown } = {}
): NormalizedGeminiFailure => ({
  envelopeState: 'not-applicable',
  failure: createProviderFailure({
    provider: 'gemini', category, safeMessage: details.safeMessage ?? 'fixed', ...details
  })
});

test('exact HTTP and provider-code allowlists plus owned timeout are fallback-eligible', () => {
  for (const status of [408, 429, 500, 502, 503, 504]) {
    assert.equal(decision(sdkError(status)), 'fallback-eligible');
  }
  for (const code of ['RESOURCE_EXHAUSTED', 'INTERNAL', 'UNAVAILABLE', 'DEADLINE_EXCEEDED']) {
    assert.equal(classifyNormalizedGeminiFailure(normalized('unknown', { code })).kind, 'fallback-eligible');
  }
  assert.equal(classifyNormalizedGeminiFailure(normalized('timeout', { code: 'ADAPTER_TIMEOUT' })).kind, 'fallback-eligible');
});

test('exact permanent controls and caller cancellation fail fast', () => {
  for (const [status, category] of [[400, 'invalid-request'], [401, 'authentication'], [402, 'billing'], [403, 'permission'], [404, 'invalid-request']] as const) {
    const result = normalizeGeminiGenerationFailure(sdkError(status, 'PERMANENT'));
    assert.equal(result.failure.category, category);
    assert.equal(classifyNormalizedGeminiFailure(result).kind, 'fail-fast');
  }
  assert.equal(classifyNormalizedGeminiFailure(normalized('cancelled', { code: 'CALLER_CANCELLED' })).kind, 'fail-fast');
  for (const category of ['authentication', 'permission', 'billing', 'invalid-request', 'unsupported-media', 'safety', 'malformed-response', 'unknown'] as const) {
    assert.equal(classifyNormalizedGeminiFailure(normalized(category)).kind, 'fail-fast');
  }
});

test('429 diagnostic prose and unrelated fields never create quota subtypes or leak', () => {
  for (const prose of ['daily RPD', 'spend project/shared', 'RPM retry quota', 'AIzaSECRET', 'data:image/png;base64,SECRET']) {
    const result = normalizeGeminiGenerationFailure(sdkError(429, 'RESOURCE_EXHAUSTED', {
      message: prose, details: [{ prose }], arbitrary: prose
    }));
    assert.equal(classifyNormalizedGeminiFailure(result).kind, 'fallback-eligible');
    assert.equal('quotaSubtype' in result.failure, false);
    assert.equal(result.failure.safeMessage.includes(prose), false);
    assert.equal(JSON.stringify(result.failure).includes(prose), false);
  }
});

test('category-only and installed-SDK transport identities are ineligible', () => {
  for (const category of ['network', 'temporary-service', 'timeout', 'rate-limit'] as const) {
    assert.equal(classifyNormalizedGeminiFailure(normalized(category)).kind, 'fail-fast');
  }
  assert.equal(GEMINI_STRUCTURED_TRANSPORT_CAPABILITIES.size, 0);
  for (const code of ['ETIMEDOUT', 'ECONNRESET', 'EAI_AGAIN']) {
    const cycle: { cause?: unknown } = {};
    cycle.cause = cycle;
    const value = normalized('network', { code, safeMessage: code, cause: cycle });
    assert.equal(classifyNormalizedGeminiFailure(value).kind, GEMINI_STRUCTURED_TRANSPORT_CAPABILITIES.has(code) ? 'fallback-eligible' : 'fail-fast');
  }
  assert.equal(decision(sdkError(503)), 'fallback-eligible');
});

test('malformed throws and wrong Error names fail closed without throwing', () => {
  const values: unknown[] = [null, undefined, 'x', 1, true, Symbol('x'), [], {}, () => undefined, Object.assign(new Error('x'), { name: 'ApiError' })];
  for (const value of values) assert.equal(decision(value), 'fail-fast');
});

test('exact envelope grammar and body boundaries reject malformed or conflicting evidence', () => {
  const messages = [
    '', ' got status: 429 X. {"error":{"code":429,"status":"RESOURCE_EXHAUSTED"}}',
    'Got status: 429 X. {"error":{"code":429,"status":"RESOURCE_EXHAUSTED"}}',
    'got status: 429 X {"error":{"code":429,"status":"RESOURCE_EXHAUSTED"}}',
    'got status: -1 X. {}', 'got status: 429 X. {',
    'got status: 429 X. {"error":{"code":429,"status":"RESOURCE_EXHAUSTED"}} trailing',
    'got status: 429 X. {"error":{"code":429}}{}',
    'got status: 429 X. {"error":{"code":503,"status":"UNAVAILABLE"}}',
    'got status: 429 X. {"error":[]}', 'got status: 429 X. {"error":{"code":"429"}}'
  ];
  for (const message of messages) {
    const error = Object.assign(new Error(message), { name: 'ClientError' });
    const result = normalizeGeminiGenerationFailure(error);
    assert.equal(result.envelopeState, 'unusable');
    assert.deepEqual(classifyNormalizedGeminiFailure(result), { kind: 'fail-fast', terminalReason: 'envelope-unusable' });
  }
  const wrongClass = sdkError(503);
  wrongClass.name = 'ClientError';
  assert.equal(normalizeGeminiGenerationFailure(wrongClass).envelopeState, 'unusable');
});

test('message ceiling accepts an exact valid 65,536-byte envelope and rejects larger before parsing', () => {
  const prefix = 'got status: 429 X. ';
  const baseBody = JSON.stringify({ error: { code: 429, status: 'RESOURCE_EXHAUSTED', pad: '' } });
  const padLength = GEMINI_ERROR_MESSAGE_MAX_BYTES - Buffer.byteLength(prefix + baseBody, 'utf8');
  const exact = Object.assign(new Error(prefix + baseBody.replace('""', `"${'a'.repeat(padLength)}"`)), { name: 'ClientError' });
  assert.equal(Buffer.byteLength(exact.message, 'utf8'), GEMINI_ERROR_MESSAGE_MAX_BYTES);
  assert.equal(normalizeGeminiGenerationFailure(exact).envelopeState, 'usable');
  const multibyteBody = JSON.stringify({ error: { code: 429, status: 'RESOURCE_EXHAUSTED', pad: '' } });
  const multibyteBudget = GEMINI_ERROR_MESSAGE_MAX_BYTES - Buffer.byteLength(prefix + multibyteBody, 'utf8');
  const emojiCount = Math.floor(multibyteBudget / 4);
  const asciiTail = multibyteBudget - emojiCount * 4;
  const exactMultibyte = Object.assign(new Error(prefix + multibyteBody.replace('""', `"${'😀'.repeat(emojiCount)}${'a'.repeat(asciiTail)}"`)), { name: 'ClientError' });
  assert.equal(Buffer.byteLength(exactMultibyte.message, 'utf8'), GEMINI_ERROR_MESSAGE_MAX_BYTES);
  assert.equal(normalizeGeminiGenerationFailure(exactMultibyte).envelopeState, 'usable');
  const over = Object.assign(new Error(`${exact.message}a`), { name: 'ClientError' });
  assert.equal(normalizeGeminiGenerationFailure(over).envelopeState, 'unusable');
  const multibyte = Object.assign(new Error(`${prefix}${JSON.stringify({ error: { code: 429, status: 'RESOURCE_EXHAUSTED', pad: '😀'.repeat(32768) } })}`), { name: 'ClientError' });
  assert.equal(normalizeGeminiGenerationFailure(multibyte).envelopeState, 'unusable');
});

test('lookalikes, nested and inherited fields never authorize fallback', () => {
  const nested = Object.assign(new Error('got status: 400 X. ' + JSON.stringify({ error: { code: 400, nested: { status: 'UNAVAILABLE' }, message: 'got status: 503 X. {}' } })), { name: 'ClientError' });
  assert.equal(decision(nested), 'fail-fast');
  const inheritedError = Object.create({ code: 429, status: 'RESOURCE_EXHAUSTED' });
  const body = JSON.stringify({ error: inheritedError });
  const inherited = Object.assign(new Error(`got status: 429 X. ${body}`), { name: 'ClientError' });
  assert.equal(normalizeGeminiGenerationFailure(inherited).envelopeState, 'unusable');
});

test('HTTP 403 has unconditional precedence over conflicting allowlisted code and prose', () => {
  for (const code of ['RESOURCE_EXHAUSTED', 'UNAVAILABLE']) {
    const result = normalizeGeminiGenerationFailure(sdkError(403, code, { message: 'billing quota retry rate' }));
    assert.equal(result.failure.category, 'permission');
    assert.equal(classifyNormalizedGeminiFailure(result).kind, 'fail-fast');
  }
  assert.equal(classifyNormalizedGeminiFailure(normalized('timeout', {
    status: 403,
    code: 'ADAPTER_TIMEOUT'
  })).kind, 'fail-fast');
});

test('hostile getters and cyclic causes are bounded and secret-free', () => {
  const hostileName = new Error('secret');
  Object.defineProperty(hostileName, 'name', { get: () => { throw new Error('getter secret'); } });
  const hostileMessage = new Error('secret');
  Object.defineProperty(hostileMessage, 'message', { get: () => { throw new Error('getter secret'); } });
  for (const value of [hostileName, hostileMessage]) assert.doesNotThrow(() => normalizeGeminiGenerationFailure(value));

  const secret = 'Bearer SECRET C:/private/file.png private prompt data:image/png;base64,AAAA';
  const raw = sdkError(500, 'INTERNAL', { message: secret });
  const cyclic: { cause?: unknown; secret: string } = { secret };
  cyclic.cause = cyclic;
  Object.defineProperty(raw, 'cause', { value: cyclic, enumerable: false });
  const result = normalizeGeminiGenerationFailure(raw);
  const publicText = result.failure.safeMessage + JSON.stringify(result.failure) + JSON.stringify(classifyNormalizedGeminiFailure(result));
  assert.equal(publicText.includes(secret), false);
  assert.equal(Object.getOwnPropertyDescriptor(result.failure, 'cause')?.enumerable, false);
});

test('pure classifier fails closed on hostile normalized fields', () => {
  const hostile = {} as NormalizedGeminiFailure;
  Object.defineProperty(hostile, 'envelopeState', { get: () => { throw new Error('no'); } });
  assert.deepEqual(classifyNormalizedGeminiFailure(hostile), { kind: 'fail-fast' });
});

test('direct fixed-three-decimal retry delay is normalized without changing eligibility', () => {
  for (const [retryDelay, expected] of [['1.250s', 1250], ['0.000s', 0]] as const) {
    const withTiming = normalizeGeminiGenerationFailure(sdkError(429, 'RESOURCE_EXHAUSTED', {
      details: [{ retryDelay }]
    }));
    const withoutTiming = normalizeGeminiGenerationFailure(sdkError(429));
    assert.equal(withTiming.failure.retryAfterMs, expected);
    assert.deepEqual(
      classifyNormalizedGeminiFailure(withTiming),
      classifyNormalizedGeminiFailure(withoutTiming)
    );
  }
});

test('unsupported retry delay values and locations are omitted without rejecting the envelope', () => {
  const invalidValues: unknown[] = [
    '1.25s', '1.2500s', '-1.000s', ' 1.250s', '1.250s ', '1e3s',
    '1250ms', 'Infinitys', Number.NaN, Infinity, -1, null, {}, [],
    `${Number.MAX_SAFE_INTEGER}.000s`
  ];
  for (const retryDelay of invalidValues) {
    const result = normalizeGeminiGenerationFailure(sdkError(429, 'RESOURCE_EXHAUSTED', {
      details: [{ retryDelay }]
    }));
    assert.equal(result.envelopeState, 'usable');
    assert.equal(result.failure.retryAfterMs, undefined);
    assert.equal(classifyNormalizedGeminiFailure(result).kind, 'fallback-eligible');
  }
  for (const extras of [
    { retryDelay: '1.250s' },
    { details: { retryDelay: '1.250s' } },
    { details: [] },
    { details: [null] },
    { details: [{ other: '1.250s' }] },
    { details: [{}, { retryDelay: '1.250s' }] }
  ]) {
    const result = normalizeGeminiGenerationFailure(sdkError(429, 'RESOURCE_EXHAUSTED', extras));
    assert.equal(result.envelopeState, 'usable');
    assert.equal(result.failure.retryAfterMs, undefined);
  }
});
