/**
 * status: active
 * phase: checkpoint-4-gemini-adapter
 * sprint: provider-foundation-first-sprint
 * last_modified: 2026-08-03
 * agent_notes: "Single-attempt Gemini adapter; live tool/server injection remains deferred."
 * insights: "Only owned timeout identity and mapped finite numeric status affect classification."
 */

import path from 'node:path';
import type { RecognitionProvider, RecognitionRequest, ProviderCallOptions } from '../types/provider.js';
import {
  GeminiService,
  GeminiVideoProcessingTimeoutError
} from './gemini.js';
import type { GeminiProviderConfig } from './provider-config.js';
import { createProviderFailure } from './provider-failure.js';

const supportedExtensions = {
  image: new Set(['.jpg', '.jpeg', '.png', '.webp']),
  audio: new Set(['.wav', '.mp3', '.ogg']),
  video: new Set(['.mp4'])
} as const;

const statusCategories = new Map<number, {
  category: 'invalid-request' | 'authentication' | 'billing' | 'permission'
    | 'rate-limit' | 'temporary-service';
  safeMessage: string;
}>([
  [400, { category: 'invalid-request', safeMessage: 'Gemini rejected the request.' }],
  [401, { category: 'authentication', safeMessage: 'Gemini authentication failed.' }],
  [402, { category: 'billing', safeMessage: 'Gemini billing authorization failed.' }],
  [403, { category: 'permission', safeMessage: 'Gemini permission was denied.' }],
  [429, { category: 'rate-limit', safeMessage: 'Gemini rate limit was reached.' }],
  [500, { category: 'temporary-service', safeMessage: 'Gemini is temporarily unavailable.' }],
  [503, { category: 'temporary-service', safeMessage: 'Gemini is temporarily unavailable.' }]
]);

const readFiniteStatus = (cause: unknown): number | undefined => {
  if ((typeof cause !== 'object' || cause === null) && typeof cause !== 'function') return undefined;
  try {
    const status = (cause as { status?: unknown }).status;
    return typeof status === 'number' && Number.isFinite(status) ? status : undefined;
  } catch {
    return undefined;
  }
};

const mapGeminiFailure = (cause: unknown): Error => {
  if (cause instanceof GeminiVideoProcessingTimeoutError) {
    return createProviderFailure({
      provider: 'gemini',
      category: 'timeout',
      safeMessage: 'Gemini video processing timed out.',
      code: 'GEMINI_VIDEO_PROCESSING_TIMEOUT',
      cause
    });
  }

  const status = readFiniteStatus(cause);
  const mapping = status === undefined ? undefined : statusCategories.get(status);
  if (mapping !== undefined) {
    return createProviderFailure({
      provider: 'gemini',
      category: mapping.category,
      safeMessage: mapping.safeMessage,
      status,
      cause
    });
  }

  return createProviderFailure({
    provider: 'gemini',
    category: 'unknown',
    safeMessage: 'Gemini request failed.',
    cause
  });
};

export class GeminiRecognitionProvider implements RecognitionProvider {
  constructor(
    private readonly service: GeminiService,
    private readonly config: GeminiProviderConfig
  ) {}

  async recognize(request: RecognitionRequest, options?: ProviderCallOptions) {
    if (options?.signal?.aborted === true) {
      throw createProviderFailure({
        provider: 'gemini',
        category: 'cancelled',
        safeMessage: 'Gemini request was cancelled.',
        code: 'CALLER_CANCELLED'
      });
    }

    const model = request.model ?? this.config.model;
    if (this.config.modelAllowlist !== undefined && !this.config.modelAllowlist.includes(model)) {
      throw createProviderFailure({
        provider: 'gemini',
        category: 'invalid-request',
        safeMessage: 'Requested model is not allowed.'
      });
    }

    const extension = path.extname(request.filepath).toLowerCase();
    if (!supportedExtensions[request.mediaKind].has(extension)) {
      throw createProviderFailure({
        provider: 'gemini',
        category: 'unsupported-media',
        safeMessage: 'Gemini does not support this media format.'
      });
    }

    try {
      const file = await this.service.uploadFile(request.filepath);
      const response = await this.service.processFileOrThrow(file, request.prompt, model);
      return { text: response.text };
    } catch (cause) {
      throw mapGeminiFailure(cause);
    }
  }
}