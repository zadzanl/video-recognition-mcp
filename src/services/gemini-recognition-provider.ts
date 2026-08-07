/**
 * status: active
 * phase: change-b-group-3-ordered-fallback
 * sprint: gemini-model-recovery
 * last_modified: 2026-08-07
 * agent_notes: "Prepares media once, then delegates validated routes to the request-local recovery router."
 * insights: "Pin validation and allowlist checks remain pre-I/O. Raw SDK fields are classifier-only and preparation stays fail-fast. The recovery deadline begins after preparation; pins are one-element routes; production Gemini generation intentionally has no new timeout."
 */

import path from 'node:path';
import type { RecognitionProvider, RecognitionRequest, ProviderCallOptions } from '../types/provider.js';
import {
  GeminiService,
  GeminiVideoProcessingTimeoutError
} from './gemini.js';
import {
  isValidProviderIdentifier,
  type GeminiProviderConfig
} from './provider-config.js';
import { createProviderFailure } from './provider-failure.js';
import { normalizeGeminiGenerationFailure } from './gemini-error-classifier.js';
import {
  formatGeminiTerminalMessage,
  runPreparedGeminiRoute
} from './gemini-recovery-router.js';

const supportedExtensions = {
  image: new Set(['.jpg', '.jpeg', '.png', '.webp']),
  audio: new Set(['.wav', '.mp3', '.ogg']),
  video: new Set(['.mp4'])
} as const;

const mapGeminiPreparationFailure = (cause: unknown): Error => {
  if (cause instanceof GeminiVideoProcessingTimeoutError) {
    return createProviderFailure({
      provider: 'gemini',
      category: 'timeout',
      safeMessage: 'Gemini video processing timed out.',
      code: 'GEMINI_VIDEO_PROCESSING_TIMEOUT',
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
    private readonly config: GeminiProviderConfig,
    private readonly runtime: {
      readonly now?: () => number;
      readonly isCandidateEligible?: (model: string) => boolean;
    } = {}
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

    const pin = request.model;
    const requestedModel = pin ?? this.config.model;
    if (!isValidProviderIdentifier(requestedModel, 200)) {
      throw createProviderFailure({
        provider: 'gemini',
        category: 'invalid-request',
        safeMessage: 'Requested model is invalid.'
      });
    }
    if (this.config.modelAllowlist !== undefined && !this.config.modelAllowlist.includes(requestedModel)) {
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

    let file;
    try {
      file = await this.service.uploadFile(request.filepath);
    } catch (cause) {
      throw mapGeminiPreparationFailure(cause);
    }
    const now = this.runtime.now ?? Date.now;
    const outcome = await runPreparedGeminiRoute({
      candidates: pin === undefined ? this.config.recovery.modelRoute : [requestedModel],
      pinned: pin !== undefined,
      maxAttempts: this.config.recovery.maxAttempts,
      deadlineSeconds: this.config.recovery.deadlineSeconds,
      deadlineStartedAt: now()
    }, {
      now,
      ...(this.runtime.isCandidateEligible === undefined
        ? {}
        : { isCandidateEligible: this.runtime.isCandidateEligible }),
      invokePreparedModel: async model => {
        try {
          const response = await this.service.processFileOrThrow(file, request.prompt, model);
          return { text: response.text };
        } catch (cause) {
          throw normalizeGeminiGenerationFailure(cause);
        }
      }
    });
    if (outcome.kind === 'success') return outcome.result;
    if (outcome.kind === 'fail-fast') throw outcome.failure;
    throw createProviderFailure({
      provider: 'gemini',
      category: outcome.reason === 'envelope-unusable' ? 'malformed-response' : 'temporary-service',
      safeMessage: formatGeminiTerminalMessage(outcome.reason, outcome.attempts)
    });
  }
}