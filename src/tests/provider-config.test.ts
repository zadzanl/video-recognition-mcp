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
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  DEFAULT_GEMINI_MODELS,
  parseGeminiModelList,
  resolveGeminiModelNames,
  formatModelDisplayLabel,
  loadRecognitionConfig,
  parseOpenRouterResponseCache,
  parseParallelPrompts,
  parseParallelAggregation,
  loadPromptTemplates,
  buildParallelInferenceConfig,
  BUILT_IN_PROMPT_TEMPLATES,
  BUILT_IN_HEADER_MERGE_TEMPLATE,
  BUILT_IN_LLM_MERGE_PROMPT
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
// parseOpenRouterResponseCache
// ---------------------------------------------------------------------------

describe('parseOpenRouterResponseCache', () => {
  it('returns undefined for undefined input', () => {
    assert.strictEqual(parseOpenRouterResponseCache(undefined), undefined);
  });

  it('returns undefined for empty string', () => {
    assert.strictEqual(parseOpenRouterResponseCache(''), undefined);
  });

  it('returns undefined for whitespace', () => {
    assert.strictEqual(parseOpenRouterResponseCache('   '), undefined);
  });

  it('parses true', () => {
    assert.strictEqual(parseOpenRouterResponseCache('true'), true);
  });

  it('parses false', () => {
    assert.strictEqual(parseOpenRouterResponseCache('false'), false);
  });

  it('throws on invalid values', () => {
    assert.throws(
      () => parseOpenRouterResponseCache('yes'),
      /OPENROUTER_RESPONSE_CACHE must be exactly "true", "false", or unset\/empty/
    );
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

  it('throws when RATE_LIMIT_MAX_WAIT_MS is invalid', () => {
    assert.throws(
      () => loadRecognitionConfig({
        GOOGLE_API_KEY: 'test-key',
        RATE_LIMIT_MAX_WAIT_MS: 'not-a-number'
      }),
      /RATE_LIMIT_MAX_WAIT_MS must be a non-negative integer in milliseconds/
    );
  });

  it('throws when MIMO_BASE_URL is invalid', () => {
    assert.throws(
      () => loadRecognitionConfig({
        GOOGLE_API_KEY: 'test-key',
        MIMO_BASE_URL: 'ftp://example.com/v1'
      }),
      /MIMO_BASE_URL must be a valid http or https URL/
    );
  });

  it('trims whitespace from MIMO_BASE_URL when provided', () => {
    const config = loadRecognitionConfig({
      GOOGLE_API_KEY: 'test-key',
      MIMO_BASE_URL: '  https://api.example.test/v1  '
    });

    assert.strictEqual(config.provider, 'gemini');
    if (config.provider === 'gemini') {
      assert.strictEqual(config.mimoBaseUrl, 'https://api.example.test/v1');
    }
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

// ---------------------------------------------------------------------------
// OpenRouter response cache config
// ---------------------------------------------------------------------------

describe('loadRecognitionConfig OpenRouter response cache', () => {
  it('adds the parsed value to direct OpenAI-compatible config', () => {
    const config = loadRecognitionConfig({
      RECOGNITION_PROVIDER: 'openai-compatible',
      OPENAI_COMPATIBLE_API_KEY: 'sk-test',
      OPENAI_COMPATIBLE_BASE_URL: 'https://openrouter.ai/api/v1',
      OPENAI_COMPATIBLE_MODEL: 'openai/gpt-4o-mini',
      OPENROUTER_RESPONSE_CACHE: 'true'
    });

    assert.strictEqual(config.provider, 'openai-compatible');
    if (config.provider === 'openai-compatible') {
      assert.strictEqual(config.openRouterResponseCache, true);
    }
  });

  it('adds the parsed value to Gemini config for fallback inheritance', () => {
    const config = loadRecognitionConfig({
      GOOGLE_API_KEY: 'test-key',
      OPENROUTER_API_KEY: 'openrouter-test-key',
      OPENROUTER_RESPONSE_CACHE: 'false'
    });

    assert.strictEqual(config.provider, 'gemini');
    if (config.provider === 'gemini') {
      assert.strictEqual(config.openRouterResponseCache, false);
    }
  });

  it('treats whitespace OPENROUTER_RESPONSE_CACHE as unset in loadRecognitionConfig', () => {
    const config = loadRecognitionConfig({
      RECOGNITION_PROVIDER: 'openai-compatible',
      OPENAI_COMPATIBLE_API_KEY: 'sk-test',
      OPENAI_COMPATIBLE_BASE_URL: 'https://api.example.com/v1',
      OPENAI_COMPATIBLE_MODEL: 'gpt-4o-mini',
      OPENROUTER_RESPONSE_CACHE: '   '
    });

    assert.strictEqual(config.provider, 'openai-compatible');
    if (config.provider === 'openai-compatible') {
      assert.strictEqual(config.openRouterResponseCache, undefined);
    }
  });
});

// ---------------------------------------------------------------------------
// Parallel Prompts parsing
// ---------------------------------------------------------------------------

describe('parseParallelPrompts', () => {
  it('defaults to 1 when undefined', () => {
    assert.strictEqual(parseParallelPrompts(undefined), 1);
  });

  it('defaults to 1 when empty string', () => {
    assert.strictEqual(parseParallelPrompts(''), 1);
  });

  it('defaults to 1 when whitespace', () => {
    assert.strictEqual(parseParallelPrompts('   '), 1);
  });

  it('accepts 1', () => {
    assert.strictEqual(parseParallelPrompts('1'), 1);
  });

  it('accepts 8', () => {
    assert.strictEqual(parseParallelPrompts('8'), 8);
  });

  it('accepts 2 through 7', () => {
    for (let n = 2; n <= 7; n++) {
      assert.strictEqual(parseParallelPrompts(String(n)), n);
    }
  });

  it('rejects 0 with clear error', () => {
    assert.throws(
      () => parseParallelPrompts('0'),
      /PARALLEL_PROMPTS must be between 1 and 8/
    );
  });

  it('rejects 9 with clear error', () => {
    assert.throws(
      () => parseParallelPrompts('9'),
      /PARALLEL_PROMPTS must be between 1 and 8/
    );
  });

  it('rejects negative numbers with clear error', () => {
    assert.throws(
      () => parseParallelPrompts('-1'),
      /PARALLEL_PROMPTS must be between 1 and 8/
    );
  });

  it('rejects non-integer with clear error', () => {
    assert.throws(
      () => parseParallelPrompts('2.5'),
      /PARALLEL_PROMPTS must be an integer between 1 and 8/
    );
  });

  it('rejects non-numeric string with clear error', () => {
    assert.throws(
      () => parseParallelPrompts('abc'),
      /PARALLEL_PROMPTS must be an integer between 1 and 8/
    );
  });
});

// ---------------------------------------------------------------------------
// Parallel Aggregation parsing
// ---------------------------------------------------------------------------

describe('parseParallelAggregation', () => {
  it('defaults to all_return when undefined', () => {
    assert.strictEqual(parseParallelAggregation(undefined), 'all_return');
  });

  it('defaults to all_return when empty string', () => {
    assert.strictEqual(parseParallelAggregation(''), 'all_return');
  });

  it('defaults to all_return when whitespace', () => {
    assert.strictEqual(parseParallelAggregation('   '), 'all_return');
  });

  it('accepts all_return', () => {
    assert.strictEqual(parseParallelAggregation('all_return'), 'all_return');
  });

  it('accepts header_merge', () => {
    assert.strictEqual(parseParallelAggregation('header_merge'), 'header_merge');
  });

  it('accepts llm_merge', () => {
    assert.strictEqual(parseParallelAggregation('llm_merge'), 'llm_merge');
  });

  it('rejects ALL_RETURN because aggregation values are case-sensitive', () => {
    assert.throws(
      () => parseParallelAggregation('ALL_RETURN'),
      /PARALLEL_AGGREGATION is case-sensitive and must be exactly one of: all_return, header_merge, llm_merge/
    );
  });

  it('rejects mixed-case aggregation aliases', () => {
    assert.throws(
      () => parseParallelAggregation('Header_Merge'),
      /PARALLEL_AGGREGATION is case-sensitive and must be exactly one of: all_return, header_merge, llm_merge/
    );
  });

  it('rejects unknown with clear error', () => {
    assert.throws(
      () => parseParallelAggregation('unknown_mode'),
      /PARALLEL_AGGREGATION is case-sensitive and must be exactly one of: all_return, header_merge, llm_merge/
    );
  });

  it('rejects empty-like but non-empty unknown with clear error', () => {
    assert.throws(
      () => parseParallelAggregation('  unknown  '),
      /PARALLEL_AGGREGATION is case-sensitive and must be exactly one of: all_return, header_merge, llm_merge/
    );
  });
});

// ---------------------------------------------------------------------------
// Template loading
// ---------------------------------------------------------------------------

describe('loadPromptTemplates', () => {
  function assertPerVariantHeaderTemplate(template: string): void {
    assert.ok(template.includes('one individual ensemble variant'));
    assert.ok(template.includes("Use only evidence from the media and the user's prompt"));
    assert.ok(template.includes('do not delete or rename sections'));
    assert.ok(template.includes('"Not observed" or "Unclear"'));
    assert.ok(template.includes('concatenate filled variant reports without synthesis'));
    assert.ok(template.includes('## Summary'));
    assert.ok(template.includes('## Key observations'));
    assert.ok(template.includes('## Temporal sequence'));
    assert.ok(template.includes('## Uncertainties and alternatives'));
    assert.strictEqual(template.includes('Combine the following agent responses'), false);
    assert.strictEqual(template.includes('## Synthesis'), false);
  }

  it('built-in header template is a per-variant fillable Markdown target, not synthesis', () => {
    assertPerVariantHeaderTemplate(BUILT_IN_HEADER_MERGE_TEMPLATE);
  });

  it('configured default header template keeps per-variant fillable Markdown semantics', () => {
    const result = loadPromptTemplates('config/prompt-templates.json');
    assertPerVariantHeaderTemplate(result.headerMergeTemplate);
  });

  it('returns built-in defaults when file is missing', () => {
    const result = loadPromptTemplates('config/nonexistent-templates.json');
    assert.deepStrictEqual(result.templates, BUILT_IN_PROMPT_TEMPLATES);
    assert.strictEqual(result.headerMergeTemplate, BUILT_IN_HEADER_MERGE_TEMPLATE);
    assert.strictEqual(result.llmMergePrompt, BUILT_IN_LLM_MERGE_PROMPT);
  });

  it('returns built-in defaults when file has malformed JSON', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-test-'));
    const badFile = path.join(tmpDir, 'bad.json');
    fs.writeFileSync(badFile, '{ invalid json');
    const result = loadPromptTemplates(badFile);
    assert.deepStrictEqual(result.templates, BUILT_IN_PROMPT_TEMPLATES);
    assert.strictEqual(result.headerMergeTemplate, BUILT_IN_HEADER_MERGE_TEMPLATE);
    assert.strictEqual(result.llmMergePrompt, BUILT_IN_LLM_MERGE_PROMPT);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('uses custom templates when valid file is present', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-test-'));
    const goodFile = path.join(tmpDir, 'good.json');
    fs.writeFileSync(goodFile, JSON.stringify({
      templates: [
        { name: 'CustomA', suffix: ' Suffix A.' },
        { name: 'CustomB', suffix: ' Suffix B.' }
      ]
    }));
    const result = loadPromptTemplates(goodFile);
    assert.strictEqual(result.templates[0].name, 'CustomA');
    assert.strictEqual(result.templates[1].name, 'CustomB');
    // Should fill shortages from built-in defaults: combined pool = 2 custom + 8 built-in = 10 unique templates
    assert.strictEqual(result.templates.length, BUILT_IN_PROMPT_TEMPLATES.length + 2);
    // Avoid duplicate names
    const names = new Set(result.templates.map(t => t.name));
    assert.strictEqual(names.size, result.templates.length);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('uses custom aggregation prompts and falls back per-field', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-test-'));
    const mixedFile = path.join(tmpDir, 'mixed.json');
    fs.writeFileSync(mixedFile, JSON.stringify({
      templates: [
        { name: 'CustomA', suffix: ' Suffix A.' }
      ],
      headerMergeTemplate: '## Custom Header\n'
    }));
    const result = loadPromptTemplates(mixedFile);
    assert.strictEqual(result.templates[0].name, 'CustomA');
    assert.strictEqual(result.headerMergeTemplate, '## Custom Header');
    // llmMergePrompt should fall back to built-in
    assert.strictEqual(result.llmMergePrompt, BUILT_IN_LLM_MERGE_PROMPT);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('warns and skips invalid templates but keeps valid ones', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-test-'));
    const mixedFile = path.join(tmpDir, 'mixed.json');
    fs.writeFileSync(mixedFile, JSON.stringify({
      templates: [
        { name: 'Valid', suffix: ' Valid suffix.' },
        { name: '', suffix: ' Invalid name.' },
        { suffix: ' Missing name.' },
        { name: 'MissingSuffix' }
      ]
    }));
    const result = loadPromptTemplates(mixedFile);
    // Only the valid template should appear first, then built-ins fill the rest
    assert.strictEqual(result.templates[0].name, 'Valid');
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// buildParallelInferenceConfig integration
// ---------------------------------------------------------------------------

describe('buildParallelInferenceConfig', () => {
  it('returns disabled when env omitted', () => {
    const config = buildParallelInferenceConfig({});
    assert.strictEqual(config.enabled, false);
    assert.strictEqual(config.promptCount, 1);
    assert.strictEqual(config.aggregation, 'all_return');
    assert.ok(config.promptTemplates.length >= 1);
    assert.strictEqual(typeof config.headerMergeTemplate, 'string');
    assert.strictEqual(typeof config.llmMergePrompt, 'string');
  });

  it('returns enabled with correct count when env set to 3', () => {
    const config = buildParallelInferenceConfig({ PARALLEL_PROMPTS: '3', PARALLEL_AGGREGATION: 'header_merge' });
    assert.strictEqual(config.enabled, true);
    assert.strictEqual(config.promptCount, 3);
    assert.strictEqual(config.aggregation, 'header_merge');
    assert.strictEqual(config.promptTemplates.length, 3);
  });

  it('returns disabled when env set to 1', () => {
    const config = buildParallelInferenceConfig({ PARALLEL_PROMPTS: '1' });
    assert.strictEqual(config.enabled, false);
    assert.strictEqual(config.promptCount, 1);
  });
});

// ---------------------------------------------------------------------------
// loadRecognitionConfig parallel integration
// ---------------------------------------------------------------------------

describe('loadRecognitionConfig parallel inference', () => {
  it('includes parallelInference on Gemini config', () => {
    const config = loadRecognitionConfig({
      GOOGLE_API_KEY: 'test-key',
      PARALLEL_PROMPTS: '4',
      PARALLEL_AGGREGATION: 'llm_merge'
    });
    assert.strictEqual(config.provider, 'gemini');
    if (config.provider === 'gemini') {
      assert.strictEqual(config.parallelInference.enabled, true);
      assert.strictEqual(config.parallelInference.promptCount, 4);
      assert.strictEqual(config.parallelInference.aggregation, 'llm_merge');
      assert.strictEqual(config.parallelInference.promptTemplates.length, 4);
    }
  });

  it('includes parallelInference on OpenAI-compatible config', () => {
    const config = loadRecognitionConfig({
      RECOGNITION_PROVIDER: 'openai-compatible',
      OPENAI_COMPATIBLE_API_KEY: 'sk-test',
      OPENAI_COMPATIBLE_BASE_URL: 'https://api.example.com/v1',
      OPENAI_COMPATIBLE_MODEL: 'gpt-4o',
      PARALLEL_PROMPTS: '2',
      PARALLEL_AGGREGATION: 'header_merge'
    });
    assert.strictEqual(config.provider, 'openai-compatible');
    if (config.provider === 'openai-compatible') {
      assert.strictEqual(config.parallelInference.enabled, true);
      assert.strictEqual(config.parallelInference.promptCount, 2);
      assert.strictEqual(config.parallelInference.aggregation, 'header_merge');
      assert.strictEqual(config.parallelInference.promptTemplates.length, 2);
    }
  });

  it('fails startup on invalid PARALLEL_PROMPTS', () => {
    assert.throws(
      () => loadRecognitionConfig({
        GOOGLE_API_KEY: 'test-key',
        PARALLEL_PROMPTS: '9'
      }),
      /PARALLEL_PROMPTS must be between 1 and 8/
    );
  });

  it('fails startup on invalid PARALLEL_AGGREGATION', () => {
    assert.throws(
      () => loadRecognitionConfig({
        GOOGLE_API_KEY: 'test-key',
        PARALLEL_AGGREGATION: 'unknown'
      }),
      /PARALLEL_AGGREGATION is case-sensitive and must be exactly one of/
    );
  });

  it('preserves baseline behavior when omitted', () => {
    const config = loadRecognitionConfig({
      GOOGLE_API_KEY: 'test-key'
    });
    assert.strictEqual(config.provider, 'gemini');
    if (config.provider === 'gemini') {
      assert.strictEqual(config.parallelInference.enabled, false);
      assert.strictEqual(config.parallelInference.promptCount, 1);
      assert.strictEqual(config.parallelInference.aggregation, 'all_return');
    }
  });
});
