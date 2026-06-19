/**
 * Recognition provider configuration and safe provider resolution.
 */

import type { ResolvedRecognitionConfig, RecognitionProviderName } from '../types/index.js';

export const DEFAULT_GEMINI_MODEL = 'gemini-2.0-flash';
export const DEFAULT_MAX_INLINE_MEDIA_BYTES = 20 * 1024 * 1024;

function readEnv(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = env[name]?.trim();
  return value ? value : undefined;
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
  const geminiModel = readEnv(env, 'GEMINI_MODEL') || DEFAULT_GEMINI_MODEL;

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
    return {
      provider: 'gemini',
      providerLabel: 'Google Gemini',
      modelName: geminiModel,
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