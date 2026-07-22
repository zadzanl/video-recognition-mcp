/**
 * Recognition provider configuration and safe provider resolution.
 */

import type { ResolvedRecognitionConfig, RecognitionProviderName, ParallelInferenceConfig, PromptTemplate, ParallelAggregationMode, ParallelDispatchMode, OpenRouterResponseCacheConfig } from '../types/index.js';
import { createLogger } from '../utils/logger.js';
import * as fs from 'node:fs';

export const DEFAULT_GEMINI_MODELS: string[] = [
  'gemini-3.5-flash',
  'gemini-3-flash-preview',
  'gemini-2.5-flash',
  'gemini-3.1-flash-lite'
];
export const DEFAULT_MAX_INLINE_MEDIA_BYTES = 20 * 1024 * 1024;

function readEnv(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = env[name]?.trim();
  return value ? value : undefined;
}

/**
 * Parse GEMINI_MODELS into a deduplicated ordered list.
 * Throws if the resulting list is empty after trimming blanks and comma separators.
 */
export function parseGeminiModelList(raw: string | undefined): string[] {
  if (raw === undefined) {
    return [];
  }

  const models = raw
    .split(',')
    .map(s => s.trim())
    .filter(s => s.length > 0);
  if (models.length === 0) {
    throw new Error(
      'GEMINI_MODELS must contain at least one model ID (value was empty after trimming blanks and comma separators)'
    );
  }

  // Deduplicate, preserving first occurrence order
  const seen = new Set<string>();
  const deduped: string[] = [];
  for (const model of models) {
    if (!seen.has(model)) {
      seen.add(model);
      deduped.push(model);
    }
  }

  return deduped;
}

/**
 * Resolve the effective ordered Gemini model list from environment variables.
 *
 * - If only GEMINI_MODEL is set: returns [GEMINI_MODEL] (single model, no fallback).
 * - If only GEMINI_MODELS is set: returns parsed, deduplicated list.
 * - If both are set: throws ambiguity error.
 * - If neither is set: returns DEFAULT_GEMINI_MODELS.
 */
export function resolveGeminiModelNames(env: NodeJS.ProcessEnv): string[] {
  const geminiModel = readEnv(env, 'GEMINI_MODEL');
  const geminiModelsPresent = Object.prototype.hasOwnProperty.call(env, 'GEMINI_MODELS');
  const geminiModelsRaw = geminiModelsPresent ? (env['GEMINI_MODELS'] ?? '') : undefined;

  if (geminiModel && geminiModelsPresent) {
    throw new Error(
      'Ambiguous Gemini model configuration: both GEMINI_MODEL and GEMINI_MODELS are set. ' +
      'Use GEMINI_MODEL for a single model or GEMINI_MODELS for a comma-separated ordered model list, but not both.'
    );
  }

  if (geminiModel) {
    return [geminiModel];
  }

  if (geminiModelsPresent) {
    return parseGeminiModelList(geminiModelsRaw);
  }

  return [...DEFAULT_GEMINI_MODELS];
}

/**
 * Build a human-readable model display label for tool descriptions.
 */
export function formatModelDisplayLabel(modelNames: string[]): string {
  if (modelNames.length === 0) {
    return '';
  }
  if (modelNames.length === 1) {
    return modelNames[0];
  }
  const fallbackCount = modelNames.length - 1;
  const plural = fallbackCount === 1 ? '' : 's';
  return `${modelNames[0]} + ${fallbackCount} fallback model${plural}`;
}

function parseMaxInlineMediaBytes(rawValue: string | undefined): number {
  if (!rawValue) {
    return DEFAULT_MAX_INLINE_MEDIA_BYTES;
  }

  const parsed = Number(rawValue);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error('MAX_INLINE_MEDIA_BYTES must be a positive integer number of bytes');
  }

  return parsed;
}

function parseRateLimitMaxWaitMs(rawValue: string | undefined): number {
  if (rawValue === undefined || rawValue.trim() === '') {
    return 30000;
  }

  const parsed = Number(rawValue);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`RATE_LIMIT_MAX_WAIT_MS must be a non-negative integer in milliseconds (received: "${rawValue}")`);
  }

  return parsed;
}

function parseMimoBaseUrl(rawValue: string | undefined): string {
  if (rawValue === undefined || rawValue.trim() === '') {
    return 'https://api.xiaomimimo.com/v1';
  }

  const value = rawValue.trim();

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`MIMO_BASE_URL must be a valid http or https URL (received: "${rawValue}")`);
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`MIMO_BASE_URL must be a valid http or https URL (received: "${rawValue}")`);
  }

  return value;
}

export function parseOpenRouterResponseCache(raw: string | undefined): OpenRouterResponseCacheConfig {
  if (raw === undefined || raw.trim() === '') {
    return undefined;
  }

  const value = raw.trim();
  if (value === 'true') {
    return true;
  }
  if (value === 'false') {
    return false;
  }

  throw new Error(`OPENROUTER_RESPONSE_CACHE must be exactly "true", "false", or unset/empty (received: "${raw}")`);
}

function requireValue(value: string | undefined, name: string, providerLabel: string): string {
  if (!value) {
    throw new Error(`${providerLabel} requires ${name}`);
  }

  return value;
}

function parseProvider(rawProvider: string | undefined): RecognitionProviderName | undefined {
  if (!rawProvider) {
    return undefined;
  }

  if (rawProvider === 'gemini' || rawProvider === 'openai-compatible') {
    return rawProvider;
  }

  throw new Error(`Unsupported RECOGNITION_PROVIDER '${rawProvider}'. Supported providers: gemini, openai-compatible`);
}

function parseModelList(raw: string | undefined, defaultList: string[]): string[] {
  if (raw === undefined || raw.trim() === '') {
    return defaultList;
  }
  const models = raw
    .split(',')
    .map(s => s.trim())
    .filter(s => s.length > 0);
  
  // Deduplicate preserving order
  const seen = new Set<string>();
  const deduped: string[] = [];
  for (const m of models) {
    if (!seen.has(m)) {
      seen.add(m);
      deduped.push(m);
    }
  }
  return deduped;
}

const logger = createLogger('ProviderConfig');

export const BUILT_IN_PROMPT_TEMPLATES: PromptTemplate[] = [
  { name: 'Descriptive', suffix: ' Provide a rich, detailed description of what you see and hear, focusing on key visual elements, colors, spatial relationships, and prominent audio features.' },
  { name: 'Enumerative', suffix: ' List all distinct objects, people, events, sounds, or spoken phrases you can identify, including approximate counts and categories.' },
  { name: 'Temporal', suffix: ' Describe the sequence of events chronologically, noting timestamps or relative order of occurrences, transitions, and changes over time.' },
  { name: 'Analytical', suffix: ' Analyze the content critically: identify themes, evaluate quality or tone, assess context, and note any anomalies or noteworthy patterns.' },
  { name: 'Technical', suffix: ' Focus on technical aspects: frame composition, camera movement, lighting conditions, audio quality, encoding artifacts, and production techniques.' },
  { name: 'Contextual', suffix: ' Provide contextual interpretation: identify setting, cultural references, language(s) spoken, text visible, and any situational or background context.' },
  { name: 'Comparative', suffix: ' Compare and contrast elements within the content: similarities, differences, before/after states, and relationships between subjects or events.' },
  { name: 'Focused', suffix: ' Give a concise, high-signal summary prioritizing the most important information and omitting minor or redundant details.' }
];

export const BUILT_IN_HEADER_MERGE_TEMPLATE = `You are filling a Markdown report for one individual ensemble variant.

Use only evidence from the media and the user's prompt. Do not use or refer to other variant outputs, do not synthesize across variants, and do not invent unsupported details. Fill every section below; do not delete or rename sections. If a section has no direct evidence, write "Not observed" or "Unclear" as appropriate. The dispatcher will later concatenate filled variant reports without synthesis.

## Summary

## Key observations

## Temporal sequence

## Uncertainties and alternatives
`;

export const BUILT_IN_LLM_MERGE_PROMPT = `You are a synthesis assistant. You will receive multiple independent recognition outputs for the same media. Your task is to produce a single coherent response that:

1. Deduplicates repeated facts.
2. Reorganizes information logically without deleting configured sections.
3. Preserves uncertainties and disagreements between agents explicitly.
4. Avoids inventing any details not supported by the provided responses.
5. Uses only the collected responses as evidence.

Return the synthesized result in Markdown format with all configured sections present. If a section lacks evidence, state "No evidence provided."`;

export const PARALLEL_PROMPTS_MIN = 1;
export const PARALLEL_PROMPTS_MAX = 8;

export function parseParallelPrompts(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') {
    return 1;
  }

  const parsed = Number(raw);
  if (!Number.isInteger(parsed)) {
    throw new Error(`PARALLEL_PROMPTS must be an integer between ${PARALLEL_PROMPTS_MIN} and ${PARALLEL_PROMPTS_MAX} (received: "${raw}")`);
  }
  if (parsed < PARALLEL_PROMPTS_MIN || parsed > PARALLEL_PROMPTS_MAX) {
    throw new Error(`PARALLEL_PROMPTS must be between ${PARALLEL_PROMPTS_MIN} and ${PARALLEL_PROMPTS_MAX} (received: ${parsed})`);
  }

  return parsed;
}

export function parseParallelAggregation(raw: string | undefined): ParallelAggregationMode {
  if (raw === undefined || raw.trim() === '') {
    return 'all_return';
  }

  const value = raw.trim();
  if (value === 'all_return' || value === 'header_merge' || value === 'llm_merge') {
    return value;
  }

  throw new Error(`PARALLEL_AGGREGATION is case-sensitive and must be exactly one of: all_return, header_merge, llm_merge (received: "${raw}")`);
}

export function parseParallelDispatchMode(raw: string | undefined): ParallelDispatchMode {
  if (raw === undefined || raw.trim() === '') {
    return 'concurrent';
  }

  const value = raw.trim();
  if (value === 'concurrent' || value === 'lead_then_fan_out') {
    return value;
  }

  throw new Error(`PARALLEL_DISPATCH_MODE is case-sensitive and must be exactly one of: concurrent, lead_then_fan_out (received: "${raw}")`);
}

export interface PromptTemplatesFile {
  templates?: { name?: string; suffix?: string }[];
  headerMergeTemplate?: string;
  llmMergePrompt?: string;
}

function isValidTemplate(t: unknown): t is { name: string; suffix: string } {
  if (typeof t !== 'object' || t === null) return false;
  const obj = t as Record<string, unknown>;
  return typeof obj.name === 'string' && obj.name.trim().length > 0 && typeof obj.suffix === 'string' && obj.suffix.trim().length > 0;
}

function isValidString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

export function loadPromptTemplates(configPath = 'config/prompt-templates.json'): { templates: PromptTemplate[]; headerMergeTemplate: string; llmMergePrompt: string } {
  let fileContent: string | undefined;
  try {
    fileContent = fs.readFileSync(configPath, 'utf-8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === 'ENOENT') {
      return { templates: [...BUILT_IN_PROMPT_TEMPLATES], headerMergeTemplate: BUILT_IN_HEADER_MERGE_TEMPLATE, llmMergePrompt: BUILT_IN_LLM_MERGE_PROMPT };
    }
    logger.warn(`Unable to read ${configPath}: ${(err as Error).message}. Using built-in defaults.`);
    return { templates: [...BUILT_IN_PROMPT_TEMPLATES], headerMergeTemplate: BUILT_IN_HEADER_MERGE_TEMPLATE, llmMergePrompt: BUILT_IN_LLM_MERGE_PROMPT };
  }

  let parsed: PromptTemplatesFile;
  try {
    parsed = JSON.parse(fileContent) as PromptTemplatesFile;
  } catch (err) {
    logger.warn(`${configPath} contains malformed JSON: ${(err as Error).message}. Using built-in defaults.`);
    return { templates: [...BUILT_IN_PROMPT_TEMPLATES], headerMergeTemplate: BUILT_IN_HEADER_MERGE_TEMPLATE, llmMergePrompt: BUILT_IN_LLM_MERGE_PROMPT };
  }

  // Validate templates array
  let customTemplates: PromptTemplate[] = [];
  if (Array.isArray(parsed.templates)) {
    const valid = parsed.templates.filter(isValidTemplate);
    if (valid.length !== parsed.templates.length) {
      const invalidCount = parsed.templates.length - valid.length;
      logger.warn(`${configPath} contained ${invalidCount} invalid template(s). Valid templates will be used; invalid ones ignored.`);
    }
    customTemplates = valid.map(t => ({ name: t.name.trim(), suffix: t.suffix.trim() }));
  } else if (parsed.templates !== undefined) {
    logger.warn(`${configPath} "templates" is not an array. Using built-in templates.`);
  }

  // Validate headerMergeTemplate
  let headerMergeTemplate = BUILT_IN_HEADER_MERGE_TEMPLATE;
  if (parsed.headerMergeTemplate !== undefined) {
    if (isValidString(parsed.headerMergeTemplate)) {
      headerMergeTemplate = parsed.headerMergeTemplate.trim();
    } else {
      logger.warn(`${configPath} "headerMergeTemplate" is invalid (must be a non-empty string). Using built-in default.`);
    }
  }

  // Validate llmMergePrompt
  let llmMergePrompt = BUILT_IN_LLM_MERGE_PROMPT;
  if (parsed.llmMergePrompt !== undefined) {
    if (isValidString(parsed.llmMergePrompt)) {
      llmMergePrompt = parsed.llmMergePrompt.trim();
    } else {
      logger.warn(`${configPath} "llmMergePrompt" is invalid (must be a non-empty string). Using built-in default.`);
    }
  }

  // Combine custom templates with built-in defaults to fill shortages, avoiding duplicates by name
  const seenNames = new Set(customTemplates.map(t => t.name));
  const combined: PromptTemplate[] = [...customTemplates];
  for (const builtin of BUILT_IN_PROMPT_TEMPLATES) {
    if (!seenNames.has(builtin.name)) {
      combined.push(builtin);
    }
  }

  return { templates: combined, headerMergeTemplate, llmMergePrompt };
}

export function buildParallelInferenceConfig(env: NodeJS.ProcessEnv = process.env): ParallelInferenceConfig {
  const promptCount = parseParallelPrompts(readEnv(env, 'PARALLEL_PROMPTS'));
  const aggregation = parseParallelAggregation(readEnv(env, 'PARALLEL_AGGREGATION'));
  const dispatchMode = parseParallelDispatchMode(readEnv(env, 'PARALLEL_DISPATCH_MODE'));
  const { templates, headerMergeTemplate, llmMergePrompt } = loadPromptTemplates();

  return {
    enabled: promptCount > 1,
    dispatchMode,
    promptCount,
    aggregation,
    promptTemplates: templates.slice(0, Math.max(promptCount, 1)),
    headerMergeTemplate,
    llmMergePrompt
  };
}

export function loadRecognitionConfig(env: NodeJS.ProcessEnv = process.env): ResolvedRecognitionConfig {
  const explicitProvider = parseProvider(readEnv(env, 'RECOGNITION_PROVIDER'));
  const googleApiKey = readEnv(env, 'GOOGLE_API_KEY');

  const openAIKey = readEnv(env, 'OPENAI_COMPATIBLE_API_KEY');
  const openAIBaseUrl = readEnv(env, 'OPENAI_COMPATIBLE_BASE_URL');
  const openAIModel = readEnv(env, 'OPENAI_COMPATIBLE_MODEL');
  const openAIProviderLabel = readEnv(env, 'OPENAI_COMPATIBLE_PROVIDER_LABEL') || 'OpenAI-compatible provider';
  const maxInlineMediaBytes = parseMaxInlineMediaBytes(readEnv(env, 'MAX_INLINE_MEDIA_BYTES'));

  const hasAnyOpenAICompatibleConfig = Boolean(openAIKey || openAIBaseUrl || openAIModel);
  const hasCompleteOpenAICompatibleConfig = Boolean(openAIKey && openAIBaseUrl && openAIModel);

  const selectedProvider: RecognitionProviderName = (() => {
    if (explicitProvider) {
      return explicitProvider;
    }

    if (googleApiKey && hasAnyOpenAICompatibleConfig) {
      throw new Error('Ambiguous recognition provider config: both GOOGLE_API_KEY and OpenAI-compatible configuration are present. Set RECOGNITION_PROVIDER=gemini or RECOGNITION_PROVIDER=openai-compatible.');
    }

    if (!googleApiKey && hasCompleteOpenAICompatibleConfig) {
      return 'openai-compatible';
    }

    return 'gemini';
  })();

  if (selectedProvider === 'gemini') {
    const modelNames = resolveGeminiModelNames(env);
    
    // Fallback providers configuration
    const openRouterApiKey = readEnv(env, 'OPENROUTER_API_KEY');
    const openRouterModels = parseModelList(
      readEnv(env, 'OPENROUTER_MODELS'),
      ['google/gemini-2.5-flash', 'google/gemini-2.5-pro', 'openai/gpt-4o-mini']
    );
    const mimoApiKey = readEnv(env, 'MIMO_API_KEY');
    const mimoModels = parseModelList(
      readEnv(env, 'MIMO_MODELS'),
      ['mimo-v2.5']
    );
    const mimoBaseUrl = parseMimoBaseUrl(readEnv(env, 'MIMO_BASE_URL'));
    const rateLimitMaxWaitMs = parseRateLimitMaxWaitMs(readEnv(env, 'RATE_LIMIT_MAX_WAIT_MS'));

    return {
      provider: 'gemini',
      providerLabel: 'Google Gemini',
      modelName: formatModelDisplayLabel(modelNames),
      modelNames,
      apiKey: requireValue(googleApiKey, 'GOOGLE_API_KEY', 'Gemini'),
      openRouterApiKey,
      openRouterModels,
      openRouterResponseCache: parseOpenRouterResponseCache(readEnv(env, 'OPENROUTER_RESPONSE_CACHE')),
      mimoApiKey,
      mimoModels,
      mimoBaseUrl,
      rateLimitMaxWaitMs,
      parallelInference: buildParallelInferenceConfig(env)
    };
  }

  return {
    provider: 'openai-compatible',
    providerLabel: openAIProviderLabel,
    modelName: requireValue(openAIModel, 'OPENAI_COMPATIBLE_MODEL', 'The OpenAI-compatible provider'),
    apiKey: requireValue(openAIKey, 'OPENAI_COMPATIBLE_API_KEY', 'The OpenAI-compatible provider'),
    baseUrl: requireValue(openAIBaseUrl, 'OPENAI_COMPATIBLE_BASE_URL', 'The OpenAI-compatible provider'),
    maxInlineMediaBytes,
    openRouterResponseCache: parseOpenRouterResponseCache(readEnv(env, 'OPENROUTER_RESPONSE_CACHE')),
    parallelInference: buildParallelInferenceConfig(env)
  };
}