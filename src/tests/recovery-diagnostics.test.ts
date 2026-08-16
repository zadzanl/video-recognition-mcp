/**
 * status: active
 * phase: change-b-group-6-observability
 * sprint: gemini-model-fallback-and-rate-limit-recovery
 * last_modified: 2026-08-08
 * agent_notes: "Exhaustive control escaping, inventory redaction, identifier boundaries, and private terminal provenance."
 * insights: "Assertions measure final escaped UTF-8 bytes and require complete fixed escapes and truncation markers."
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  RECOVERY_DIAGNOSTIC_MAX_BYTES,
  RECOVERY_DIAGNOSTIC_TRUNCATION_MARKER,
  createRecoveryTerminalFailure,
  escapeAndTruncateDiagnostic,
  escapedDiagnosticUnits,
  formatRecoveryTerminalMessage,
  getRecoveryTerminalMessage,
  isMediaKind,
  sanitizeOperatorMessage
} from '../services/recovery-diagnostics.js';
import { createProviderFailure } from '../services/provider-failure.js';

test('C0 C1 and every Bidi_Control become complete fixed uppercase escapes', () => {
  const codePoints = [
    ...Array.from({ length: 0x20 }, (_, value) => value),
    ...Array.from({ length: 0x21 }, (_, value) => value + 0x7f),
    0x061c, 0x200e, 0x200f,
    ...Array.from({ length: 5 }, (_, value) => value + 0x202a),
    ...Array.from({ length: 4 }, (_, value) => value + 0x2066)
  ];
  for (const codePoint of codePoints) {
    const expected = `\\u${codePoint.toString(16).toUpperCase().padStart(4, '0')}`;
    assert.deepEqual(escapedDiagnosticUnits(String.fromCodePoint(codePoint)), [expected]);
  }
});

test('UTF-8 truncation preserves astral scalars, escapes, and marker inside 4 KiB', () => {
  const output = escapeAndTruncateDiagnostic(`${'😀'.repeat(1019)}\u0000${'x'.repeat(100)}`);
  assert.equal(Buffer.byteLength(output, 'utf8') <= RECOVERY_DIAGNOSTIC_MAX_BYTES, true);
  assert.equal(output.endsWith(RECOVERY_DIAGNOSTIC_TRUNCATION_MARKER), true);
  assert.doesNotMatch(output, /\\u[0-9A-F]{0,3}$/u);
  assert.doesNotThrow(() => Buffer.from(output, 'utf8').toString('utf8'));
});

test('provider model and media diagnostic identifiers fail closed at exact scalar boundaries', () => {
  const valid = formatRecoveryTerminalMessage('image', 'route-exhausted', [{
    provider: '😀'.repeat(64), model: '😀'.repeat(200), attempt: 1, category: 'rate-limit'
  }]);
  assert.match(valid, /reason=route-exhausted/u);
  for (const [provider, model] of [
    ['a'.repeat(65), 'model'], ['😀'.repeat(65), 'model'],
    ['provider', 'a'.repeat(201)], ['provider', '😀'.repeat(201)],
    ['bad\u0000', 'model'], ['bad\u2066', 'model'], ['provider', 'bad\u200B']
  ]) {
    const output = formatRecoveryTerminalMessage('image', 'route-exhausted', [{
      provider, model, attempt: 1, category: 'unknown'
    }]);
    assert.equal(output, 'Recognition recovery failed: diagnostic unavailable.');
    assert.equal(output.includes(provider), false);
    assert.equal(output.includes(model), false);
  }
  assert.equal(isMediaKind('image'), true);
  assert.equal(isMediaKind('audio'), true);
  assert.equal(isMediaKind('video'), true);
  assert.equal(isMediaKind('hostile-media'), false);
  assert.equal(formatRecoveryTerminalMessage('hostile-media', 'route-exhausted', []), 'Recognition recovery failed: diagnostic unavailable.');
});

test('operator sanitizer covers every explicit redaction inventory category', () => {
  const cases = [
    ['credentials or API keys', 'api_key=APIKEY_SENTINEL'],
    ['authorization headers', 'Authorization: Bearer AUTH_SENTINEL'],
    ['data URLs', 'data:image/png;base64,DATAURLSENTINEL=='],
    ['prompts', 'prompt="PROMPT_SENTINEL"'],
    ['paths', 'C:\\private\\PATH_SENTINEL.png'],
    ['file contents', 'file_content=FILECONTENT_SENTINEL'],
    ['encoded media', 'encoded_media=RU5DT0RFRE1FRElBU0VOVElORUw='],
    ['complete or upstream provider bodies', 'upstream_body={"secret":"BODY_SENTINEL"}']
  ] as const;
  for (const [label, fixture] of cases) {
    const output = sanitizeOperatorMessage(`failure ${fixture}`);
    assert.equal(output.includes('<redacted>'), true, label);
    assert.equal(output.includes('SENTINEL'), false, label);
  }
});

test('known values redact before escaping and truncation while residual format controls fail closed', () => {
  const secret = 'KNOWN_VALUE_SENTINEL';
  const output = sanitizeOperatorMessage(`${'x'.repeat(4090)}${secret}\u0000`, { knownValues: [secret] });
  assert.equal(output.includes(secret), false);
  assert.equal(Buffer.byteLength(output, 'utf8') <= RECOVERY_DIAGNOSTIC_MAX_BYTES, true);
  assert.equal(output.endsWith(RECOVERY_DIAGNOSTIC_TRUNCATION_MARKER), true);
  assert.equal(sanitizeOperatorMessage('unexpected\u200Bformat'), 'Provider diagnostic unavailable.');
});

test('trusted terminal diagnostics are private and cannot be forged through public failure fields', () => {
  const hostile = 'api_key=HOSTILE_SAFE_MESSAGE_SENTINEL prompt=DO_NOT_ECHO';
  const failure = createRecoveryTerminalFailure({
    provider: 'gemini', category: 'temporary-service', mediaKind: 'video',
    reason: 'deadline-terminated',
    attempts: [{ provider: 'gemini', model: 'model', attempt: 1, category: 'timeout' }]
  });
  assert.equal(failure.safeMessage, 'Recognition recovery failed.');
  const terminal = getRecoveryTerminalMessage(failure);
  assert.match(terminal ?? '', /media=video.*reason=deadline-terminated/u);
  assert.equal((terminal ?? '').includes(hostile), false);
  assert.equal(JSON.stringify(failure).includes('deadline-terminated'), false);
  assert.equal(JSON.stringify({ ...failure }).includes('deadline-terminated'), false);
  assert.equal(Object.keys(failure).includes('terminalMessage'), false);
  assert.equal('terminalMessage' in failure, false);

  const forged = createProviderFailure({
    provider: 'gemini', category: 'temporary-service', safeMessage: failure.safeMessage
  });
  Object.assign(forged, { terminalMessage: terminal });
  assert.equal(getRecoveryTerminalMessage(forged), undefined);
});