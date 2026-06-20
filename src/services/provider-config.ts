/**
 * Recognition provider configuration and safe provider resolution.
 */

import type { ResolvedRecognitionConfig, RecognitionProviderName } from '../types/index.js';

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
    return {
      provider: 'gemini',
      providerLabel: 'Google Gemini',
      modelName: formatModelDisplayLabel(modelNames),
      modelNames,
      apiKey: requireValue(googleApiKey, 'GOOGLE_API_KEY', 'Gemini')
    };
  }

  return {
    provider: 'openai-compatible',
    providerLabel: openAIProviderLabel,
    modelName: requireValue(openAIModel, 'OPENAI_COMPATIBLE_MODEL', 'The OpenAI-compatible provider'),
    apiKey: requireValue(openAIKey, 'OPENAI_COMPATIBLE_API_KEY', 'The OpenAI-compatible provider'),
    baseUrl: requireValue(openAIBaseUrl, 'OPENAI_COMPATIBLE_BASE_URL', 'The OpenAI-compatible provider'),
    maxInlineMediaBytes
  };
}