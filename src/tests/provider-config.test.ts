/**
 * Tests for Gemini model fallback configuration parsing.
 *
 * status: ACTIVE
 * phase: MVP
 * sprint: unknown
 * last_modified: 2026-06-19
 * agent_notes: "Tests for parseGeminiModelList, resolveGeminiModelNames, formatModelDisplayLabel, and loadRecognitionConfig fallback config."
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_GEMINI_MODELS,
  parseGeminiModelList,
  resolveGeminiModelNames,
  formatModelDisplayLabel,
  loadRecognitionConfig
} from '../services/provider-config.js';

// ---------------------------------------------------------------------------
// DEFAULT_GEMINI_MODELS
// ---------------------------------------------------------------------------

describe('DEFAULT_GEMINI_MODELS', () => {
  it('contains the expected ordered fallback chain', () => {
    assert.deepStrictEqual(DEFAULT_GEMINI_MODELS, [
      'gemini-3.5-flash',
      'gemini-3-flash-preview',
      'gemini-2.5-flash',
      'gemini-3.1-flash-lite'
    ]);
  });

  it('has no duplicates', () => {
    const seen = new Set(DEFAULT_GEMINI_MODELS);
    assert.strictEqual(seen.size, DEFAULT_GEMINI_MODELS.length);
  });
});

// ---------------------------------------------------------------------------
// parseGeminiModelList
// ---------------------------------------------------------------------------

describe('parseGeminiModelList', () => {
  it('returns empty array for undefined input', () => {
    assert.deepStrictEqual(parseGeminiModelList(undefined), []);
  });

  it('throws on empty string', () => {
    assert.throws(
      () => parseGeminiModelList(''),
      /GEMINI_MODELS must contain at least one model ID/
    );
  });

  it('parses a single model', () => {
    assert.deepStrictEqual(parseGeminiModelList('gemini-3.5-flash'), ['gemini-3.5-flash']);
  });

  it('parses comma-separated models', () => {
    assert.deepStrictEqual(
      parseGeminiModelList('gemini-3.5-flash,gemini-2.5-flash,gemini-3.1-flash-lite'),
      ['gemini-3.5-flash', 'gemini-2.5-flash', 'gemini-3.1-flash-lite']
    );
  });

  it('trims whitespace around model IDs', () => {
    assert.deepStrictEqual(
      parseGeminiModelList('  gemini-3.5-flash , gemini-2.5-flash  ,gemini-3.1-flash-lite'),
      ['gemini-3.5-flash', 'gemini-2.5-flash', 'gemini-3.1-flash-lite']
    );
  });

  it('deduplicates preserving first occurrence order', () => {
    assert.deepStrictEqual(
      parseGeminiModelList('gemini-3.5-flash,gemini-2.5-flash,gemini-3.5-flash,gemini-3.1-flash-lite,gemini-2.5-flash'),
      ['gemini-3.5-flash', 'gemini-2.5-flash', 'gemini-3.1-flash-lite']
    );
  });

  it('throws on value that is empty after trimming blanks and commas', () => {
    assert.throws(
      () => parseGeminiModelList(', , ,'),
      /GEMINI_MODELS must contain at least one model ID/
    );
  });

  it('throws on whitespace-only value with commas', () => {
    assert.throws(
      () => parseGeminiModelList('  ,  ,  '),
      /GEMINI_MODELS must contain at least one model ID/
    );
  });

  it('handles trailing commas gracefully (filters empty entries)', () => {
    // Trailing comma produces an empty entry which is filtered out.
    assert.deepStrictEqual(
      parseGeminiModelList('gemini-3.5-flash,gemini-2.5-flash,'),
      ['gemini-3.5-flash', 'gemini-2.5-flash']
    );
  });
});

// ---------------------------------------------------------------------------
// resolveGeminiModelNames
// ---------------------------------------------------------------------------

describe('resolveGeminiModelNames', () => {
  it('returns default chain when neither GEMINI_MODEL nor GEMINI_MODELS is set', () => {
    const result = resolveGeminiModelNames({});
    assert.deepStrictEqual(result, DEFAULT_GEMINI_MODELS);
  });

  it('returns single model when only GEMINI_MODEL is set', () => {
    const result = resolveGeminiModelNames({ GEMINI_MODEL: 'gemini-2.0-flash' });
    assert.deepStrictEqual(result, ['gemini-2.0-flash']);
  });

  it('returns parsed list when only GEMINI_MODELS is set', () => {
    const result = resolveGeminiModelNames({
      GEMINI_MODELS: 'gemini-3.5-flash,gemini-2.5-flash'
    });
    assert.deepStrictEqual(result, ['gemini-3.5-flash', 'gemini-2.5-flash']);
  });

  it('throws when both GEMINI_MODEL and GEMINI_MODELS are set', () => {
    assert.throws(
      () => resolveGeminiModelNames({
        GEMINI_MODEL: 'gemini-2.0-flash',
        GEMINI_MODELS: 'gemini-3.5-flash,gemini-2.5-flash'
      }),
      /Ambiguous Gemini model configuration: both GEMINI_MODEL and GEMINI_MODELS are set/
    );
  });

  it('throws when GEMINI_MODELS is empty after trimming', () => {
    assert.throws(
      () => resolveGeminiModelNames({ GEMINI_MODELS: '  ,  ' }),
      /GEMINI_MODELS must contain at least one model ID/
    );
  });

  it('deduplicates models from GEMINI_MODELS', () => {
    const result = resolveGeminiModelNames({
      GEMINI_MODELS: 'gemini-3.5-flash,gemini-3.5-flash,gemini-2.5-flash'
    });
    assert.deepStrictEqual(result, ['gemini-3.5-flash', 'gemini-2.5-flash']);
  });

  it('trims whitespace in GEMINI_MODEL', () => {
    const result = resolveGeminiModelNames({ GEMINI_MODEL: '  gemini-2.0-flash  ' });
    assert.deepStrictEqual(result, ['gemini-2.0-flash']);
  });

  it('throws when GEMINI_MODELS is empty string', () => {
    assert.throws(
      () => resolveGeminiModelNames({ GEMINI_MODELS: '' }),
      /GEMINI_MODELS must contain at least one model ID/
    );
  });

  it('throws when GEMINI_MODELS is whitespace only', () => {
    assert.throws(
      () => resolveGeminiModelNames({ GEMINI_MODELS: '   ' }),
      /GEMINI_MODELS must contain at least one model ID/
    );
  });

  it('throws ambiguity when GEMINI_MODEL set and GEMINI_MODELS is empty', () => {
    assert.throws(
      () => resolveGeminiModelNames({ GEMINI_MODEL: 'gemini-2.0-flash', GEMINI_MODELS: '' }),
      /Ambiguous Gemini model configuration: both GEMINI_MODEL and GEMINI_MODELS are set/
    );
  });

  it('throws ambiguity when GEMINI_MODEL set and GEMINI_MODELS is whitespace', () => {
    assert.throws(
      () => resolveGeminiModelNames({ GEMINI_MODEL: 'gemini-2.0-flash', GEMINI_MODELS: '   ' }),
      /Ambiguous Gemini model configuration: both GEMINI_MODEL and GEMINI_MODELS are set/
    );
  });
});

// ---------------------------------------------------------------------------
// formatModelDisplayLabel
// ---------------------------------------------------------------------------

describe('formatModelDisplayLabel', () => {
  it('returns exact model name for single model', () => {
    assert.strictEqual(formatModelDisplayLabel(['gemini-3.5-flash']), 'gemini-3.5-flash');
  });

  it('returns primary + n fallback models for two models', () => {
    assert.strictEqual(
      formatModelDisplayLabel(['gemini-3.5-flash', 'gemini-2.5-flash']),
      'gemini-3.5-flash + 1 fallback model'
    );
  });

  it('returns primary + n fallback models for more than two models', () => {
    assert.strictEqual(
      formatModelDisplayLabel(['gemini-3.5-flash', 'gemini-3-flash-preview', 'gemini-2.5-flash', 'gemini-3.1-flash-lite']),
      'gemini-3.5-flash + 3 fallback models'
    );
  });

  it('returns exact model name for empty list (defensive)', () => {
    // Should not happen in practice, but exercise the code path.
    assert.strictEqual(formatModelDisplayLabel([]), '');
  });
});

// ---------------------------------------------------------------------------
// loadRecognitionConfig integration (config-level assertions)
// ---------------------------------------------------------------------------

describe('loadRecognitionConfig Gemini model fallback', () => {
  it('returns default model chain when Gemini is selected with only GOOGLE_API_KEY', () => {
    const config = loadRecognitionConfig({
      GOOGLE_API_KEY: 'test-key'
    });
    assert.strictEqual(config.provider, 'gemini');
    if (config.provider === 'gemini') {
      assert.deepStrictEqual(config.modelNames, DEFAULT_GEMINI_MODELS);
      assert.strictEqual(config.modelName, 'gemini-3.5-flash + 3 fallback models');
    }
  });

  it('returns single model when GEMINI_MODEL is set', () => {
    const config = loadRecognitionConfig({
      GOOGLE_API_KEY: 'test-key',
      GEMINI_MODEL: 'gemini-2.0-flash'
    });
    assert.strictEqual(config.provider, 'gemini');
    if (config.provider === 'gemini') {
      assert.deepStrictEqual(config.modelNames, ['gemini-2.0-flash']);
      assert.strictEqual(config.modelName, 'gemini-2.0-flash');
    }
  });

  it('returns parsed model list when GEMINI_MODELS is set', () => {
    const config = loadRecognitionConfig({
      GOOGLE_API_KEY: 'test-key',
      GEMINI_MODELS: 'gemini-3.5-flash,gemini-2.5-flash'
    });
    assert.strictEqual(config.provider, 'gemini');
    if (config.provider === 'gemini') {
      assert.deepStrictEqual(config.modelNames, ['gemini-3.5-flash', 'gemini-2.5-flash']);
      assert.strictEqual(config.modelName, 'gemini-3.5-flash + 1 fallback model');
    }
  });

  it('throws when both GEMINI_MODEL and GEMINI_MODELS are set', () => {
    assert.throws(
      () => loadRecognitionConfig({
        GOOGLE_API_KEY: 'test-key',
        GEMINI_MODEL: 'gemini-2.0-flash',
        GEMINI_MODELS: 'gemini-3.5-flash,gemini-2.5-flash'
      }),
      /Ambiguous Gemini model configuration/
    );
  });

  it('throws when GEMINI_MODELS is empty in loadRecognitionConfig', () => {
    assert.throws(
      () => loadRecognitionConfig({
        GOOGLE_API_KEY: 'test-key',
        GEMINI_MODELS: ''
      }),
      /GEMINI_MODELS must contain at least one model ID/
    );
  });

  it('throws when GEMINI_MODELS is whitespace in loadRecognitionConfig', () => {
    assert.throws(
      () => loadRecognitionConfig({
        GOOGLE_API_KEY: 'test-key',
        GEMINI_MODELS: '   '
      }),
      /GEMINI_MODELS must contain at least one model ID/
    );
  });

  it('throws ambiguity when both GEMINI_MODEL set and GEMINI_MODELS empty in loadRecognitionConfig', () => {
    assert.throws(
      () => loadRecognitionConfig({
        GOOGLE_API_KEY: 'test-key',
        GEMINI_MODEL: 'gemini-2.0-flash',
        GEMINI_MODELS: ''
      }),
      /Ambiguous Gemini model configuration/
    );
  });

  it('throws ambiguity when both GEMINI_MODEL set and GEMINI_MODELS whitespace in loadRecognitionConfig', () => {
    assert.throws(
      () => loadRecognitionConfig({
        GOOGLE_API_KEY: 'test-key',
        GEMINI_MODEL: 'gemini-2.0-flash',
        GEMINI_MODELS: '   '
      }),
      /Ambiguous Gemini model configuration/
    );
  });
});

// ---------------------------------------------------------------------------
// OpenAI-compatible provider independence
// ---------------------------------------------------------------------------

describe('loadRecognitionConfig OpenAI-compatible independence', () => {
  it('does not add modelNames to OpenAI-compatible config', () => {
    const config = loadRecognitionConfig({
      RECOGNITION_PROVIDER: 'openai-compatible',
      OPENAI_COMPATIBLE_API_KEY: 'sk-test',
      OPENAI_COMPATIBLE_BASE_URL: 'https://api.example.com/v1',
      OPENAI_COMPATIBLE_MODEL: 'gpt-4o'
    });
    assert.strictEqual(config.provider, 'openai-compatible');
    // OpenAI-compatible config should NOT have modelNames
    assert.ok(!('modelNames' in config));
  });

  it('Gemini config with GEMINI_MODELS does not leak to OpenAI-compatible', () => {
    // When forced to openai-compatible via RECOGNITION_PROVIDER,
    // GEMINI_MODELS should have no effect.
    const config = loadRecognitionConfig({
      RECOGNITION_PROVIDER: 'openai-compatible',
      OPENAI_COMPATIBLE_API_KEY: 'sk-test',
      OPENAI_COMPATIBLE_BASE_URL: 'https://api.example.com/v1',
      OPENAI_COMPATIBLE_MODEL: 'gpt-4o',
      GEMINI_MODELS: 'gemini-3.5-flash,gemini-2.5-flash'
    });
    assert.strictEqual(config.provider, 'openai-compatible');
    assert.ok(!('modelNames' in config));
    assert.strictEqual(config.modelName, 'gpt-4o');
  });
});
