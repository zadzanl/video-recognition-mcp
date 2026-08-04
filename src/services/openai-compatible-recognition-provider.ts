/**
 * status: active
 * phase: phase-4a-standalone-adapter
 * sprint: provider-foundation-first-sprint
 * last_modified: 2026-08-04
 * agent_notes: "Phase 4a standalone adapter; pre-abort, allowlist, media matrix, exact request, strict response and failure mapping, manual redirect. Unwired by design."
 * insights: "Use video/mov and audio/mp3 per design; oversized input is unsupported-media; rejected manual 3xx is unknown; incremental reader uses getReader/TextDecoder without claiming Phase 4b byte cap or timeout ownership."
 */

import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import type {
  MediaKind,
  ProviderCallOptions,
  ProviderFailureCategory,
  RecognitionProvider,
  RecognitionRequest,
  RecognitionResult
} from '../types/provider.js';
import type { OpenAICompatibleProviderConfig } from './provider-config.js';
import { createProviderFailure } from './provider-failure.js';

const ALLOWLIST_SAFE_MESSAGE = 'Requested model is not allowed.';

const safeMessages: Readonly<Record<ProviderFailureCategory, string>> = {
  configuration: 'OpenAI-compatible provider configuration is invalid.',
  authentication: 'OpenAI-compatible provider authentication failed.',
  permission: 'OpenAI-compatible provider permission was denied.',
  billing: 'OpenAI-compatible provider billing authorization failed.',
  'invalid-request': 'OpenAI-compatible provider rejected the request.',
  'unsupported-media': 'OpenAI-compatible provider does not support this media.',
  safety: 'OpenAI-compatible provider refused the request for safety reasons.',
  'rate-limit': 'OpenAI-compatible provider rate limit was reached.',
  timeout: 'OpenAI-compatible request timed out.',
  'temporary-service': 'OpenAI-compatible provider is temporarily unavailable.',
  network: 'OpenAI-compatible network request failed.',
  cancelled: 'OpenAI-compatible request was cancelled.',
  'malformed-response': 'OpenAI-compatible provider returned a malformed response.',
  unknown: 'OpenAI-compatible request failed.'
};

interface MediaType {
  mime: string;
  format?: 'wav' | 'mp3';
}

const mediaTypes: Readonly<Record<MediaKind, Readonly<Record<string, MediaType>>>> = {
  image: {
    '.jpg': { mime: 'image/jpeg' },
    '.jpeg': { mime: 'image/jpeg' },
    '.png': { mime: 'image/png' },
    '.webp': { mime: 'image/webp' }
  },
  audio: {
    '.wav': { mime: 'audio/wav', format: 'wav' },
    '.mp3': { mime: 'audio/mp3', format: 'mp3' }
  },
  video: {
    '.mp4': { mime: 'video/mp4' },
    '.mpeg': { mime: 'video/mpeg' },
    '.mov': { mime: 'video/mov' },
    '.webm': { mime: 'video/webm' }
  }
};

const resolveMediaType = (mediaKind: MediaKind, filepath: string): MediaType => {
  const extension = path.extname(filepath).toLowerCase();
  const map = mediaTypes[mediaKind];
  const found = map[extension];
  if (found === undefined) {
    throw createProviderFailure({
      provider: 'openai-compatible',
      category: 'unsupported-media',
      safeMessage: safeMessages['unsupported-media']
    });
  }
  return found;
};

const buildMediaPart = (mediaKind: MediaKind, mediaType: MediaType, base64: string) => {
  if (mediaKind === 'image') {
    return {
      type: 'image_url',
      image_url: { url: `data:${mediaType.mime};base64,${base64}` }
    };
  }
  if (mediaKind === 'audio') {
    if (mediaType.format === undefined) {
      throw createProviderFailure({
        provider: 'openai-compatible',
        category: 'configuration',
        safeMessage: safeMessages.configuration
      });
    }
    return {
      type: 'input_audio',
      input_audio: { data: base64, format: mediaType.format }
    };
  }
  return {
    type: 'video_url',
    video_url: { url: `data:${mediaType.mime};base64,${base64}` }
  };
};

const errorTypeCategories: ReadonlyMap<string, ProviderFailureCategory> = new Map([
  ['authentication', 'authentication'],
  ['permission_denied', 'permission'],
  ['payment_required', 'billing'],
  ['rate_limit_exceeded', 'rate-limit'],
  ['provider_overloaded', 'temporary-service'],
  ['provider_unavailable', 'temporary-service'],
  ['server', 'temporary-service'],
  ['timeout', 'timeout'],
  ['content_policy_violation', 'safety'],
  ['refusal', 'safety'],
  ['invalid_image', 'unsupported-media'],
  ['image_too_large', 'unsupported-media'],
  ['image_too_small', 'unsupported-media'],
  ['unsupported_image_format', 'unsupported-media'],
  ['image_not_found', 'unsupported-media'],
  ['image_download_failed', 'unsupported-media'],
  ['context_length_exceeded', 'invalid-request'],
  ['max_tokens_exceeded', 'invalid-request'],
  ['token_limit_exceeded', 'invalid-request'],
  ['string_too_long', 'invalid-request'],
  ['invalid_request', 'invalid-request'],
  ['invalid_prompt', 'invalid-request'],
  ['not_found', 'invalid-request'],
  ['precondition_failed', 'invalid-request'],
  ['payload_too_large', 'invalid-request'],
  ['unprocessable', 'invalid-request']
]);

const categoryForErrorType = (errorType: string): ProviderFailureCategory | undefined =>
  errorTypeCategories.get(errorType);

const categoryForStatus = (status: number): ProviderFailureCategory => {
  if (status === 401) return 'authentication';
  if (status === 402) return 'billing';
  if (status === 403) return 'permission';
  if (status === 408 || status === 504) return 'timeout';
  if (status === 415) return 'unsupported-media';
  if (status === 429) return 'rate-limit';
  if (
    status === 400 || status === 404 || status === 412 || status === 413 || status === 422
  ) {
    return 'invalid-request';
  }
  if (status === 500 || status === 502 || status === 503) return 'temporary-service';
  if (status >= 400 && status < 500) return 'invalid-request';
  if (status >= 500 && status < 600) return 'temporary-service';
  return 'unknown';
};

const readErrorType = (value: unknown): string | undefined => {
  if (typeof value !== 'object' || value === null) return undefined;
  const error = (value as { error?: unknown }).error;
  if (typeof error !== 'object' || error === null) return undefined;
  const metadata = (error as { metadata?: unknown }).metadata;
  if (typeof metadata !== 'object' || metadata === null) return undefined;
  const errorType = (metadata as { error_type?: unknown }).error_type;
  return typeof errorType === 'string' ? errorType : undefined;
};

const hasErrorObject = (value: unknown): boolean => {
  if (typeof value !== 'object' || value === null) return false;
  const error = (value as { error?: unknown }).error;
  return typeof error === 'object' && error !== null;
};

const hasChoiceErrorMarker = (value: unknown): boolean => {
  if (typeof value !== 'object' || value === null) return false;
  if ((value as { finish_reason?: unknown }).finish_reason === 'error') return true;
  return hasErrorObject(value);
};

const parseRetryAfter = (headers: Headers): number | undefined => {
  const raw = headers.get('retry-after');
  if (raw === null) return undefined;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return undefined;
  if (!/^[0-9]+(\.[0-9]+)?$/u.test(trimmed)) return undefined;
  const seconds = Number(trimmed);
  if (!Number.isFinite(seconds) || seconds < 0) return undefined;
  const milliseconds = Math.round(seconds * 1000);
  if (!Number.isSafeInteger(milliseconds)) return undefined;
  return milliseconds;
};

const readResponseText = async (response: Response): Promise<string> => {
  const body = response.body;
  if (body === null) return '';
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value !== undefined) {
        text += decoder.decode(value, { stream: true });
      }
    }
    text += decoder.decode();
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // reader may already be released
    }
  }
  return text;
};

interface MappedFailureOptions {
  category: ProviderFailureCategory;
  status?: number;
  code?: string;
  retryAfterMs?: number;
  cause?: unknown;
}

const mappedFailure = (options: MappedFailureOptions) =>
  createProviderFailure({
    provider: 'openai-compatible',
    category: options.category,
    safeMessage: safeMessages[options.category],
    ...(options.status !== undefined ? { status: options.status } : {}),
    ...(options.code !== undefined ? { code: options.code } : {}),
    ...(options.retryAfterMs !== undefined ? { retryAfterMs: options.retryAfterMs } : {}),
    ...(options.cause !== undefined ? { cause: options.cause } : {})
  });

const is2xx = (status: number): boolean => status >= 200 && status < 300;

const is3xx = (status: number): boolean => status >= 300 && status < 400;

const isSignalAborted = (signal: AbortSignal | undefined): boolean =>
  signal !== undefined && signal.aborted === true;

const parseProviderResponse = async (response: Response): Promise<string> => {
  if (is3xx(response.status)) {
    throw mappedFailure({ category: 'unknown', status: response.status });
  }

  const text = await readResponseText(response);
  const retryAfterMs = parseRetryAfter(response.headers);

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    if (is2xx(response.status)) {
      throw mappedFailure({ category: 'malformed-response' });
    }
    throw mappedFailure({
      category: categoryForStatus(response.status),
      status: response.status,
      retryAfterMs
    });
  }

  // Choice-level structured error takes precedence over HTTP-status mapping
  if (typeof parsed === 'object' && parsed !== null) {
    const choices = (parsed as { choices?: unknown }).choices;
    if (Array.isArray(choices) && choices.length > 0) {
      const choice = choices[0];
      if (typeof choice === 'object' && choice !== null) {
        const choiceErrorType = readErrorType(choice);
        if (choiceErrorType !== undefined) {
          const category = categoryForErrorType(choiceErrorType)
            ?? categoryForStatus(response.status);
          throw mappedFailure({ category, status: response.status, retryAfterMs });
        }
      }
    }
  }

  // Top-level structured error takes precedence over HTTP-status mapping
  const topLevelErrorType = readErrorType(parsed);
  if (topLevelErrorType !== undefined) {
    const category = categoryForErrorType(topLevelErrorType) ?? categoryForStatus(response.status);
    throw mappedFailure({ category, status: response.status, retryAfterMs });
  }

  if (is2xx(response.status)) {
    if (typeof parsed !== 'object' || parsed === null) {
      throw mappedFailure({ category: 'malformed-response' });
    }
    const choices = (parsed as { choices?: unknown }).choices;
    if (!Array.isArray(choices) || choices.length === 0) {
      throw mappedFailure({ category: 'malformed-response' });
    }
    const choice = choices[0];
    if (typeof choice !== 'object' || choice === null) {
      throw mappedFailure({ category: 'malformed-response' });
    }
    if (hasChoiceErrorMarker(choice)) {
      throw mappedFailure({ category: 'malformed-response' });
    }
    const message = (choice as { message?: unknown }).message;
    if (typeof message !== 'object' || message === null) {
      throw mappedFailure({ category: 'malformed-response' });
    }
    const content = (message as { content?: unknown }).content;
    if (typeof content !== 'string') {
      throw mappedFailure({ category: 'malformed-response' });
    }
    if (content.trim().length === 0) {
      throw mappedFailure({ category: 'malformed-response' });
    }
    return content;
  }

  // Non-2xx without recognized structured error: HTTP-status mapping
  throw mappedFailure({
    category: categoryForStatus(response.status),
    status: response.status,
    retryAfterMs
  });
};

const readFileSafely = async (filepath: string, maxBytes: number): Promise<string> => {
  let stats;
  try {
    stats = await stat(filepath);
  } catch (cause) {
    throw mappedFailure({ category: 'unsupported-media', cause });
  }
  if (stats.size > maxBytes) {
    throw mappedFailure({ category: 'unsupported-media' });
  }
  try {
    const buffer = await readFile(filepath);
    return buffer.toString('base64');
  } catch (cause) {
    throw mappedFailure({ category: 'unsupported-media', cause });
  }
};

export class OpenAICompatibleRecognitionProvider implements RecognitionProvider {
  constructor(
    private readonly config: OpenAICompatibleProviderConfig,
    private readonly fetchFn: typeof globalThis.fetch = globalThis.fetch
  ) {}

  async recognize(
    request: RecognitionRequest,
    options?: ProviderCallOptions
  ): Promise<RecognitionResult> {
    if (isSignalAborted(options?.signal)) {
      throw mappedFailure({ category: 'cancelled', code: 'CALLER_CANCELLED' });
    }

    const model = request.model ?? this.config.model;
    if (this.config.modelAllowlist !== undefined
      && !this.config.modelAllowlist.includes(model)) {
      throw createProviderFailure({
        provider: 'openai-compatible',
        category: 'invalid-request',
        safeMessage: ALLOWLIST_SAFE_MESSAGE
      });
    }

    const mediaType = resolveMediaType(request.mediaKind, request.filepath);
    const base64 = await readFileSafely(request.filepath, this.config.maxInlineMediaBytes);
    const mediaPart = buildMediaPart(request.mediaKind, mediaType, base64);

    const body = JSON.stringify({
      model,
      stream: false,
      messages: [
        {
          role: 'user',
          content: [{ type: 'text', text: request.prompt }, mediaPart]
        }
      ]
    });

    const init: RequestInit = {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.config.apiKey}`,
        'Content-Type': 'application/json'
      },
      body,
      redirect: 'manual',
      ...(options?.signal !== undefined ? { signal: options.signal } : {})
    };

    let response: Response;
    try {
      response = await this.fetchFn(this.config.baseUrl.toString(), init);
    } catch (cause) {
      if (isSignalAborted(options?.signal)) {
        throw mappedFailure({ category: 'cancelled', code: 'CALLER_CANCELLED', cause });
      }
      throw mappedFailure({ category: 'network', cause });
    }

    try {
      const text = await parseProviderResponse(response);
      return { text };
    } catch (cause) {
      if (cause instanceof Error && 'provider' in cause) {
        throw cause;
      }
      throw mappedFailure({ category: 'network', cause });
    }
  }
}
