/**
 * Recognition provider factory and provider implementations.
 */

import { createLogger } from '../utils/logger.js';
import type {
  GeminiFile,
  GeminiRecognitionConfig,
  OpenAICompatibleRecognitionConfig,
  ProviderCallOptions,
  RecognitionProvider,
  RecognitionRequest,
  RecognitionResult,
  RecognitionUsageMetadata,
  ResolvedRecognitionConfig
} from '../types/index.js';
import { GeminiService } from './gemini.js';
import { classifyGeminiError } from './gemini-error-classifier.js';
import type { ErrorClassification } from './gemini-error-classifier.js';
import { createBase64DataUrl, createRawBase64, validateMediaFile, audioFormatFromExtension } from './media.js';
import { RateLimitTracker } from './rate-limit-tracker.js';
import { ThrottlingScheduler } from './throttling-scheduler.js';
import { DEFAULT_MAX_INLINE_MEDIA_BYTES } from './provider-config.js';

const log = createLogger('RecognitionProviders');

const openAiCompatibleFailureOrigin = Symbol('openAiCompatibleFailureOrigin');

type OpenAICompatibleFailureOrigin =
  | { kind: 'http'; status: number }
  | { kind: 'transport'; stage: 'fetch'; error: unknown }
  | { kind: 'transport'; stage: 'response-read'; status: number; error: unknown }
  | { kind: 'local'; stage: 'validation' | 'encoding' | 'request-build'; error: unknown }
  | { kind: 'structural'; stage: 'unsupported-response-shape' };

function createOpenAICompatibleFailure(
  text: string,
  origin: OpenAICompatibleFailureOrigin
): RecognitionResult {
  const result: RecognitionResult = { text, isError: true };
  Object.defineProperty(result, openAiCompatibleFailureOrigin, {
    value: origin,
    enumerable: false,
    writable: false,
    configurable: false
  });
  return result;
}

type TransportFailureCode = 'EPIPE' | 'EHOSTUNREACH';

function readOpenAICompatibleFailureOrigin(result: RecognitionResult): OpenAICompatibleFailureOrigin | undefined {
  try {
    const origin = (result as unknown as Record<symbol, unknown>)[openAiCompatibleFailureOrigin];
    if (!origin || typeof origin !== 'object') {
      return undefined;
    }

    const candidate = origin as Partial<OpenAICompatibleFailureOrigin>;
    if (candidate.kind === 'http' && typeof candidate.status === 'number') {
      return candidate as OpenAICompatibleFailureOrigin;
    }
    if (candidate.kind === 'transport' && candidate.stage === 'fetch') {
      return candidate as OpenAICompatibleFailureOrigin;
    }
    if (
      candidate.kind === 'transport'
      && candidate.stage === 'response-read'
      && typeof candidate.status === 'number'
    ) {
      return candidate as OpenAICompatibleFailureOrigin;
    }
    if (candidate.kind === 'local' || candidate.kind === 'structural') {
      return candidate as OpenAICompatibleFailureOrigin;
    }
  } catch {
    // A result can only carry this symbol when created in this module, but do
    // not let an unexpected getter/proxy disrupt fallback routing.
  }

  return undefined;
}

function classifyAuthoritativeHttpStatus(status: number): ErrorClassification {
  switch (status) {
    case 401:
      return { retryable: false, reason: 'unauthenticated' };
    case 402:
      return { retryable: false, reason: 'payment required' };
    case 403:
      return { retryable: false, reason: 'permission denied' };
    case 400:
      return { retryable: false, reason: 'invalid request/argument' };
    case 429:
      return { retryable: true, reason: 'rate limited (429)' };
    case 500:
      return { retryable: true, reason: 'internal server error (500)' };
    case 502:
    case 503:
    case 504:
      return { retryable: true, reason: 'transient upstream error' };
    default:
      if (Number.isInteger(status) && status >= 400 && status < 500) {
        return { retryable: false, reason: `HTTP client error (${status})` };
      }
      return { retryable: false, reason: 'unrecognized HTTP failure' };
  }
}

function isStructuredErrorValue(value: unknown): value is object {
  return value !== null && (typeof value === 'object' || typeof value === 'function');
}

function readStructuredErrorProperty(error: object, property: 'code' | 'cause'): unknown {
  try {
    return (error as Record<'code' | 'cause', unknown>)[property];
  } catch {
    return undefined;
  }
}

function findTransportFailureCode(error: unknown): TransportFailureCode | undefined {
  const visited = new Set<object>();
  let current = error;

  for (let inspected = 0; inspected < 8 && isStructuredErrorValue(current); inspected += 1) {
    if (visited.has(current)) {
      return undefined;
    }
    visited.add(current);

    const code = readStructuredErrorProperty(current, 'code');
    if (code === 'EPIPE' || code === 'EHOSTUNREACH') {
      return code;
    }

    current = readStructuredErrorProperty(current, 'cause');
  }

  return undefined;
}

function findRecognizableHttpStatus(message: string): number | undefined {
  const httpOrStatusMatch = /\b(?:HTTP(?:\s+STATUS)?|STATUS(?:\s+CODE)?)\s*(?:[:=]\s*|\(\s*)?([1-5]\d{2})\b/i.exec(message);
  const apiErrorMatch = /\bAPI\s+ERROR\s*\(\s*([1-5]\d{2})\b/i.exec(message);
  const statusMatch = !apiErrorMatch || (httpOrStatusMatch && httpOrStatusMatch.index < apiErrorMatch.index)
    ? httpOrStatusMatch
    : apiErrorMatch;
  return statusMatch ? Number.parseInt(statusMatch[1], 10) : undefined;
}

function classifyOpenAICompatibleFailure(result: RecognitionResult): ErrorClassification {
  const origin = readOpenAICompatibleFailureOrigin(result);
  if (!origin) {
    return classifyOpenAiError(result.text);
  }

  if (origin.kind === 'http') {
    return classifyAuthoritativeHttpStatus(origin.status);
  }

  if (origin.kind === 'transport') {
    if (origin.stage === 'response-read' && (origin.status < 200 || origin.status >= 300)) {
      return classifyAuthoritativeHttpStatus(origin.status);
    }

    const transportCode = findTransportFailureCode(origin.error);
    if (transportCode === 'EPIPE') {
      return { retryable: true, reason: 'broken pipe' };
    }
    if (transportCode === 'EHOSTUNREACH') {
      return { retryable: true, reason: 'host unreachable' };
    }
    return { retryable: true, reason: 'transient network failure' };
  }

  if (origin.kind === 'local') {
    return { retryable: false, reason: 'local provider failure' };
  }

  return { retryable: false, reason: 'unsupported response shape' };
}

export function classifyOpenAiError(message: string): { retryable: boolean; reason: string } {
  const status = findRecognizableHttpStatus(message);
  if (status !== undefined) {
    return classifyAuthoritativeHttpStatus(status);
  }

  const msg = message.toUpperCase();

  if (/UNAUTHORIZED|INVALID API KEY|INVALID_API_KEY/.test(msg)) {
    return { retryable: false, reason: 'unauthenticated' };
  }
  if (/FORBIDDEN|PERMISSION_DENIED|PERMISSION DENIED/.test(msg)) {
    return { retryable: false, reason: 'permission denied' };
  }
  if (/INVALID_ARGUMENT|INVALID REQUEST|INVALID_REQUEST|MALFORMED|UNSUPPORTED MEDIA|UNSUPPORTED/.test(msg)) {
    return { retryable: false, reason: 'invalid request/argument' };
  }
  if (/RATE LIMIT|TOO MANY REQUESTS|RESOURCE_EXHAUSTED/.test(msg)) {
    return { retryable: true, reason: 'rate limited (429)' };
  }
  if (/INTERNAL SERVER/.test(msg)) {
    return { retryable: true, reason: 'internal server error (500)' };
  }
  if (/BAD GATEWAY|SERVICE UNAVAILABLE|GATEWAY TIMEOUT/.test(msg)) {
    return { retryable: true, reason: 'transient upstream error' };
  }
  if (/TIMEOUT|DEADLINE[_ ]EXCEEDED|ABORTED|ABORT_ERR|ETIMEDOUT|ECONNRESET|EAI_AGAIN|ENOTFOUND|ECONNREFUSED|FETCH FAILED|FAILED TO FETCH|UND_ERR/.test(msg)) {
    return { retryable: true, reason: 'transient network failure' };
  }
  // Safe default for general errors is fail-fast
  return { retryable: false, reason: sanitizeOpenAiErrorText(message) };
}

function sanitizeOpenAiErrorText(text: string): string {
  const compact = text
    .replace(/Bearer\s+[A-Za-z0-9._+/=-]+/gi, 'Bearer [redacted]')
    .replace(/sk-[A-Za-z0-9._-]{8,}/gi, '[redacted api key]')
    .replace(/"api[_-]?key"\s*:\s*"[^"]*"/gi, '"api_key":"[redacted]"')
    .replace(/data:[^\s"']+/gi, 'data:[redacted]')
    .replace(/\s+/g, ' ')
    .trim();

  if (compact.length <= 240) {
    return compact;
  }

  return `${compact.slice(0, 240)}...`;
}

export class GeminiRecognitionProvider implements RecognitionProvider {
  readonly info;
  private readonly geminiService: GeminiService;
  private readonly tracker: RateLimitTracker;
  private readonly scheduler: ThrottlingScheduler;

  constructor(
    private readonly config: GeminiRecognitionConfig,
    geminiService?: GeminiService
  ) {
    this.info = {
      provider: config.provider,
      providerLabel: config.providerLabel,
      modelName: config.modelName
    };
    this.geminiService = geminiService ?? new GeminiService({ apiKey: config.apiKey });
    this.tracker = new RateLimitTracker();
    this.scheduler = new ThrottlingScheduler(this.tracker);
  }

  async recognize(request: RecognitionRequest, options?: ProviderCallOptions): Promise<RecognitionResult> {
    // Defensive: empty modelNames is a configuration error.
    if (!this.config.modelNames || this.config.modelNames.length === 0) {
      log.error('Gemini configuration error: no model names configured');
      return {
        text: 'Gemini configuration error: no model names configured',
        isError: true
      };
    }

    await validateMediaFile(this.info.providerLabel, this.info.provider, request.mediaKind, request.filepath);

    // Build overall fallback routing model candidate list:
    // Gemini models -> OpenRouter models -> MiMo models
    const candidates = [...this.config.modelNames];
    if (this.config.openRouterApiKey && this.config.openRouterModels) {
      candidates.push(...this.config.openRouterModels);
    }
    if (this.config.mimoApiKey && this.config.mimoModels) {
      candidates.push(...this.config.mimoModels);
    }

    const attempted: { model: string; reason: string }[] = [];
    let geminiFile: GeminiFile | null = null;

    while (true) {
      // Get remaining candidates that have not been attempted yet
      const remainingCandidates = candidates.filter(c => !attempted.some(a => a.model === c));
      if (remainingCandidates.length === 0) {
        break;
      }

      let selectedModel: string;
      try {
        selectedModel = await this.scheduler.scheduleRequest(
          remainingCandidates,
          request.mediaKind,
          this.config.rateLimitMaxWaitMs ?? 30000
        );
      } catch (err) {
        const timeoutMsg = err instanceof Error ? err.message : String(err);
        log.error(`Rate-limit recovery routing exhausted: ${timeoutMsg}`);
        return {
          text: `Rate-limit recovery routing exhausted: ${timeoutMsg}. Attempted: ${attempted.map(a => `${a.model} (${a.reason})`).join(', ')}`,
          isError: true
        };
      }

      try {
        if (this.config.modelNames.includes(selectedModel)) {
          // Gemini model attempt
          if (!geminiFile) {
            log.debug(`Uploading media file for Gemini models: ${request.filepath}`);
            geminiFile = await this.geminiService.uploadFile(request.filepath);
          }
          log.info(`Attempting Gemini generation with model ${selectedModel}`);
          const result = await this.geminiService.processFile(geminiFile, request.prompt, selectedModel);
          
          if (attempted.length > 0) {
            log.info(`Gemini fallback succeeded with model ${selectedModel} after attempting ${attempted.map(a => a.model).join(', ')}`);
          } else {
            log.info(`Gemini generation succeeded with primary model ${selectedModel}`);
          }
          return result;
        } else if (this.config.openRouterApiKey && this.config.openRouterModels?.includes(selectedModel)) {
          // OpenRouter model attempt
          log.info(`Attempting OpenRouter generation with model ${selectedModel}`);
          const openRouterConfig = {
            provider: 'openai-compatible' as const,
            providerLabel: 'OpenRouter',
            modelName: selectedModel,
            apiKey: this.config.openRouterApiKey,
            baseUrl: 'https://openrouter.ai/api/v1',
            maxInlineMediaBytes: DEFAULT_MAX_INLINE_MEDIA_BYTES,
            openRouterResponseCache: this.config.openRouterResponseCache,
            parallelInference: this.config.parallelInference
          };
          const provider = new OpenAICompatibleRecognitionProvider(openRouterConfig);
          const result = await provider.recognize(request, options);
          if (result.isError) {
            const classification = classifyOpenAICompatibleFailure(result);
            log.warn(`OpenRouter model ${selectedModel} failed: ${classification.reason}`);
            if (!classification.retryable) {
              log.error(`OpenRouter fail-fast error on model ${selectedModel}: ${classification.reason}`);
              return result; // Fail-fast immediately
            }
            this.tracker.markCooldown(selectedModel);
            attempted.push({ model: selectedModel, reason: classification.reason });
            continue;
          }
          return result;
        } else if (this.config.mimoApiKey && this.config.mimoModels?.includes(selectedModel)) {
          // MiMo model attempt
          log.info(`Attempting MiMo generation with model ${selectedModel}`);
          const mimoConfig = {
            provider: 'openai-compatible' as const,
            providerLabel: 'MiMo',
            modelName: selectedModel,
            apiKey: this.config.mimoApiKey,
            baseUrl: this.config.mimoBaseUrl || 'https://api.xiaomimimo.com/v1',
            maxInlineMediaBytes: DEFAULT_MAX_INLINE_MEDIA_BYTES,
            parallelInference: this.config.parallelInference
          };
          const provider = new OpenAICompatibleRecognitionProvider(mimoConfig);
          const result = await provider.recognize(request, options);
          if (result.isError) {
            const classification = classifyOpenAICompatibleFailure(result);
            log.warn(`MiMo model ${selectedModel} failed: ${classification.reason}`);
            if (!classification.retryable) {
              log.error(`MiMo fail-fast error on model ${selectedModel}: ${classification.reason}`);
              return result; // Fail-fast immediately
            }
            this.tracker.markCooldown(selectedModel);
            attempted.push({ model: selectedModel, reason: classification.reason });
            continue;
          }
          return result;
        } else {
          throw new Error(`Unknown model in routing chain: ${selectedModel}`);
        }
      } catch (error) {
        const classification: ErrorClassification = classifyGeminiError(error);
        log.warn(`Model ${selectedModel} failed: ${classification.reason}`);

        if (!classification.retryable) {
          // Fail-fast: do not attempt further models or providers.
          log.error(`Fail-fast error on model ${selectedModel}: ${classification.reason}`);
          return {
            text: `Gemini generation failed: ${classification.reason}`,
            isError: true
          };
        }

        // Fallback-eligible: mark model as cooling down, record, and loop to try next scheduled model
        this.tracker.markCooldown(selectedModel);
        attempted.push({ model: selectedModel, reason: classification.reason });
      }
    }

    // Exhausted all configured models.
    const modelList = attempted.map(a => `${a.model} (${a.reason})`).join(', ');
    log.error(`Model fallback exhausted. Attempted: ${modelList}`);
    return {
      text: `Gemini model fallback exhausted. Attempted models: ${modelList}`,
      isError: true
    };
  }

  async synthesizeText(prompt: string, options?: ProviderCallOptions): Promise<RecognitionResult> {
    // Defensive: empty modelNames is a configuration error.
    if (!this.config.modelNames || this.config.modelNames.length === 0) {
      log.error('Gemini configuration error: no model names configured for text synthesis');
      return {
        text: 'Gemini configuration error: no model names configured for text synthesis',
        isError: true
      };
    }

    const candidates = [...this.config.modelNames];
    if (this.config.openRouterApiKey && this.config.openRouterModels) {
      candidates.push(...this.config.openRouterModels);
    }
    if (this.config.mimoApiKey && this.config.mimoModels) {
      candidates.push(...this.config.mimoModels);
    }

    const attempted: { model: string; reason: string }[] = [];

    while (true) {
      const remainingCandidates = candidates.filter(c => !attempted.some(a => a.model === c));
      if (remainingCandidates.length === 0) {
        break;
      }

      let selectedModel: string;
      try {
        // Text synthesis is lightweight compared with media recognition. Use
        // the existing scheduler with the smallest token estimate so synthesis
        // still respects cooldowns and request caps without widening scheduler
        // public types in this phase.
        selectedModel = await this.scheduler.scheduleRequest(
          remainingCandidates,
          'image',
          this.config.rateLimitMaxWaitMs ?? 30000
        );
      } catch (err) {
        const timeoutMsg = err instanceof Error ? err.message : String(err);
        log.error(`Text synthesis routing exhausted: ${timeoutMsg}`);
        return {
          text: `Text synthesis routing exhausted: ${timeoutMsg}. Attempted: ${attempted.map(a => `${a.model} (${a.reason})`).join(', ')}`,
          isError: true
        };
      }

      try {
        if (this.config.modelNames.includes(selectedModel)) {
          log.info(`Attempting Gemini text synthesis with model ${selectedModel}`);
          return await this.geminiService.processText(prompt, selectedModel);
        } else if (this.config.openRouterApiKey && this.config.openRouterModels?.includes(selectedModel)) {
          log.info(`Attempting OpenRouter text synthesis with model ${selectedModel}`);
          const openRouterConfig = {
            provider: 'openai-compatible' as const,
            providerLabel: 'OpenRouter',
            modelName: selectedModel,
            apiKey: this.config.openRouterApiKey,
            baseUrl: 'https://openrouter.ai/api/v1',
            maxInlineMediaBytes: DEFAULT_MAX_INLINE_MEDIA_BYTES,
            openRouterResponseCache: this.config.openRouterResponseCache,
            parallelInference: this.config.parallelInference
          };
          const provider = new OpenAICompatibleRecognitionProvider(openRouterConfig);
          const result = await provider.synthesizeText(prompt, options);
          if (result.isError) {
            const classification = classifyOpenAICompatibleFailure(result);
            log.warn(`OpenRouter text synthesis model ${selectedModel} failed: ${classification.reason}`);
            if (!classification.retryable) {
              return result;
            }
            this.tracker.markCooldown(selectedModel);
            attempted.push({ model: selectedModel, reason: classification.reason });
            continue;
          }
          return result;
        } else if (this.config.mimoApiKey && this.config.mimoModels?.includes(selectedModel)) {
          log.info(`Attempting MiMo text synthesis with model ${selectedModel}`);
          const mimoConfig = {
            provider: 'openai-compatible' as const,
            providerLabel: 'MiMo',
            modelName: selectedModel,
            apiKey: this.config.mimoApiKey,
            baseUrl: this.config.mimoBaseUrl || 'https://api.xiaomimimo.com/v1',
            maxInlineMediaBytes: DEFAULT_MAX_INLINE_MEDIA_BYTES,
            parallelInference: this.config.parallelInference
          };
          const provider = new OpenAICompatibleRecognitionProvider(mimoConfig);
          const result = await provider.synthesizeText(prompt, options);
          if (result.isError) {
            const classification = classifyOpenAICompatibleFailure(result);
            log.warn(`MiMo text synthesis model ${selectedModel} failed: ${classification.reason}`);
            if (!classification.retryable) {
              return result;
            }
            this.tracker.markCooldown(selectedModel);
            attempted.push({ model: selectedModel, reason: classification.reason });
            continue;
          }
          return result;
        } else {
          throw new Error(`Unknown model in text synthesis routing chain: ${selectedModel}`);
        }
      } catch (error) {
        const classification: ErrorClassification = classifyGeminiError(error);
        log.warn(`Text synthesis model ${selectedModel} failed: ${classification.reason}`);

        if (!classification.retryable) {
          return {
            text: `Gemini text synthesis failed: ${classification.reason}`,
            isError: true
          };
        }

        this.tracker.markCooldown(selectedModel);
        attempted.push({ model: selectedModel, reason: classification.reason });
      }
    }

    const modelList = attempted.map(a => `${a.model} (${a.reason})`).join(', ');
    return {
      text: `Gemini text synthesis fallback exhausted. Attempted models: ${modelList}`,
      isError: true
    };
  }
}

interface OpenAICompatibleMessageContentPart {
  type: string;
  text?: string;
  image_url?: { url: string };
  video_url?: { url: string };
  input_audio?: { data: string; format: string };
}

interface OpenAICompatibleMessage {
  role: 'system' | 'developer' | 'user';
  content: string | OpenAICompatibleMessageContentPart[];
}

interface OpenAICompatibleRequestBody {
  model: string;
  messages: OpenAICompatibleMessage[];
  session_id?: string;
}

interface OpenAICompatibleChatResponse {
  id?: unknown;
  model?: unknown;
  usage?: unknown;
  choices?: unknown;
  error?: unknown;
}

class OpenAICompatibleRecognitionProvider implements RecognitionProvider {
  readonly info;
  private readonly chatCompletionsUrl: string;

  constructor(private readonly config: OpenAICompatibleRecognitionConfig) {
    this.info = {
      provider: config.provider,
      providerLabel: config.providerLabel,
      modelName: config.modelName
    };
    this.chatCompletionsUrl = `${config.baseUrl.replace(/\/+$/, '')}/chat/completions`;
  }

  async recognize(request: RecognitionRequest, options?: ProviderCallOptions): Promise<RecognitionResult> {
    let media: Awaited<ReturnType<typeof validateMediaFile>>;
    try {
      media = await validateMediaFile(this.info.providerLabel, this.info.provider, request.mediaKind, request.filepath);
    } catch (error) {
      return createOpenAICompatibleFailure(
        `Error processing file with ${this.info.providerLabel}: ${sanitizeOpenAiErrorText(error instanceof Error ? error.message : String(error))}`,
        { kind: 'local', stage: 'validation', error }
      );
    }

    let mediaPart: OpenAICompatibleMessageContentPart;
    try {
      if (request.mediaKind === 'audio') {
        const rawBase64 = await createRawBase64(media, this.config.maxInlineMediaBytes);
        const format = audioFormatFromExtension(media.extension);
        mediaPart = this.createAudioMediaPart(rawBase64, format);
      } else {
        const dataUrl = await createBase64DataUrl(media, this.config.maxInlineMediaBytes);
        mediaPart = this.createMediaPart(request.mediaKind, dataUrl);
      }
    } catch (error) {
      return createOpenAICompatibleFailure(
        `Error processing file with ${this.info.providerLabel}: ${sanitizeOpenAiErrorText(error instanceof Error ? error.message : String(error))}`,
        { kind: 'local', stage: 'encoding', error }
      );
    }

    let requestInit: RequestInit;
    try {
      log.debug(`Sending ${request.mediaKind} recognition request to ${this.info.providerLabel} using model ${this.info.modelName}`);
      const messages = this.createRecognitionMessages(request, mediaPart, options);
      requestInit = {
        method: 'POST',
        headers: this.createRequestHeaders(),
        body: JSON.stringify(this.createRequestBody(messages, options))
      };
    } catch (error) {
      return createOpenAICompatibleFailure(
        `Error processing file with ${this.info.providerLabel}: ${sanitizeOpenAiErrorText(error instanceof Error ? error.message : String(error))}`,
        { kind: 'local', stage: 'request-build', error }
      );
    }

    let response: Response;
    try {
      response = await fetch(this.chatCompletionsUrl, requestInit);
    } catch (error) {
      return createOpenAICompatibleFailure(
        `Error processing file with ${this.info.providerLabel}: ${sanitizeOpenAiErrorText(error instanceof Error ? error.message : String(error))}`,
        { kind: 'transport', stage: 'fetch', error }
      );
    }

    let responseText: string;
    try {
      responseText = await response.text();
    } catch (error) {
      return createOpenAICompatibleFailure(
        `Error processing file with ${this.info.providerLabel}: ${sanitizeOpenAiErrorText(error instanceof Error ? error.message : String(error))}`,
        { kind: 'transport', stage: 'response-read', status: response.status, error }
      );
    }

    const parsed = this.parseJsonResponse(responseText);

    if (!response.ok) {
      return createOpenAICompatibleFailure(
        `${this.info.providerLabel} API error (${response.status} ${response.statusText}): ${sanitizeOpenAiErrorText(this.extractErrorMessage(parsed, responseText))}`,
        { kind: 'http', status: response.status }
      );
    }

    const text = this.extractAssistantText(parsed);
    if (!text) {
      return createOpenAICompatibleFailure(
        `${this.info.providerLabel} returned an unsupported or empty chat completion response shape`,
        { kind: 'structural', stage: 'unsupported-response-shape' }
      );
    }

    const usage = this.extractUsageMetadata(parsed);
    return usage ? { text, usage } : { text };
  }

  async synthesizeText(prompt: string, options?: ProviderCallOptions): Promise<RecognitionResult> {
    let requestInit: RequestInit;
    try {
      log.debug(`Sending text-only synthesis request to ${this.info.providerLabel} using model ${this.info.modelName}`);
      const messages: OpenAICompatibleMessage[] = [
        {
          role: 'user',
          content: prompt
        }
      ];
      requestInit = {
        method: 'POST',
        headers: this.createRequestHeaders(),
        body: JSON.stringify(this.createRequestBody(messages, options))
      };
    } catch (error) {
      return createOpenAICompatibleFailure(
        `Error synthesizing text with ${this.info.providerLabel}: ${sanitizeOpenAiErrorText(error instanceof Error ? error.message : String(error))}`,
        { kind: 'local', stage: 'request-build', error }
      );
    }

    let response: Response;
    try {
      response = await fetch(this.chatCompletionsUrl, requestInit);
    } catch (error) {
      return createOpenAICompatibleFailure(
        `Error synthesizing text with ${this.info.providerLabel}: ${sanitizeOpenAiErrorText(error instanceof Error ? error.message : String(error))}`,
        { kind: 'transport', stage: 'fetch', error }
      );
    }

    let responseText: string;
    try {
      responseText = await response.text();
    } catch (error) {
      return createOpenAICompatibleFailure(
        `Error synthesizing text with ${this.info.providerLabel}: ${sanitizeOpenAiErrorText(error instanceof Error ? error.message : String(error))}`,
        { kind: 'transport', stage: 'response-read', status: response.status, error }
      );
    }

    const parsed = this.parseJsonResponse(responseText);

    if (!response.ok) {
      return createOpenAICompatibleFailure(
        `${this.info.providerLabel} API error (${response.status} ${response.statusText}): ${sanitizeOpenAiErrorText(this.extractErrorMessage(parsed, responseText))}`,
        { kind: 'http', status: response.status }
      );
    }

    const text = this.extractAssistantText(parsed);
    if (!text) {
      return createOpenAICompatibleFailure(
        `${this.info.providerLabel} returned an unsupported or empty text synthesis response shape`,
        { kind: 'structural', stage: 'unsupported-response-shape' }
      );
    }

    const usage = this.extractUsageMetadata(parsed);
    return usage ? { text, usage } : { text };
  }

  private createMediaPart(mediaKind: 'image' | 'video', dataUrl: string): OpenAICompatibleMessageContentPart {
    if (mediaKind === 'image') {
      return {
        type: 'image_url',
        image_url: { url: dataUrl }
      };
    }

    return {
      type: 'video_url',
      video_url: { url: dataUrl }
    };
  }

  private createAudioMediaPart(rawBase64: string, format: string): OpenAICompatibleMessageContentPart {
    return {
      type: 'input_audio',
      input_audio: { data: rawBase64, format }
    };
  }

  private createRecognitionMessages(
    request: RecognitionRequest,
    mediaPart: OpenAICompatibleMessageContentPart,
    options?: ProviderCallOptions
  ): OpenAICompatibleMessage[] {
    const messages: OpenAICompatibleMessage[] = [];

    if (options?.stableInstruction) {
      messages.push({
        role: options.stableInstruction.role,
        content: options.stableInstruction.text
      });
    }

    messages.push({
      role: 'user',
      content: this.createRecognitionUserContent(request, mediaPart, options)
    });

    return messages;
  }

  private createRecognitionUserContent(
    request: RecognitionRequest,
    mediaPart: OpenAICompatibleMessageContentPart,
    options?: ProviderCallOptions
  ): OpenAICompatibleMessageContentPart[] {
    if (!options?.promptLayout) {
      return [
        { type: 'text', text: request.prompt },
        mediaPart
      ];
    }

    const content: OpenAICompatibleMessageContentPart[] = [
      { type: 'text', text: options.promptLayout.stableTextPrefix },
      mediaPart
    ];

    const suffix = options.promptLayout.variableTextSuffix;
    if (suffix) {
      content.push({ type: 'text', text: suffix });
    }

    return content;
  }

  private createRequestBody(messages: OpenAICompatibleMessage[], options?: ProviderCallOptions): OpenAICompatibleRequestBody {
    const body: OpenAICompatibleRequestBody = {
      model: this.config.modelName,
      messages
    };

    if (options?.sessionId !== undefined) {
      body.session_id = options.sessionId;
    }

    return body;
  }

  private createRequestHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.config.apiKey}`,
      'Content-Type': 'application/json'
    };

    const cacheHeader = this.openRouterResponseCacheHeader();
    if (cacheHeader !== undefined) {
      headers['X-OpenRouter-Cache'] = cacheHeader;
    }

    return headers;
  }

  private openRouterResponseCacheHeader(): string | undefined {
    if (this.config.openRouterResponseCache === undefined || !isOpenRouterEndpoint(this.config.baseUrl)) {
      return undefined;
    }

    return this.config.openRouterResponseCache ? 'true' : 'false';
  }

  private parseJsonResponse(responseText: string): OpenAICompatibleChatResponse | undefined {
    try {
      return JSON.parse(responseText) as OpenAICompatibleChatResponse;
    } catch {
      return undefined;
    }
  }

  private extractAssistantText(response: OpenAICompatibleChatResponse | undefined): string | undefined {
    try {
      const choices = response?.choices;
      if (!Array.isArray(choices)) {
        return undefined;
      }

      const firstChoice = choices[0];
      if (!firstChoice || typeof firstChoice !== 'object') {
        return undefined;
      }

      const message = firstChoice.message;
      if (!message || typeof message !== 'object') {
        return undefined;
      }

      const content = message.content;
      if (typeof content === 'string') {
        return content;
      }

      if (!Array.isArray(content)) {
        return undefined;
      }

      const textParts: string[] = [];
      for (const part of content) {
        if (!part || typeof part !== 'object') {
          return undefined;
        }

        if (typeof part.text === 'string' && part.text) {
          textParts.push(part.text);
        }
      }

      return textParts.length > 0 ? textParts.join('\n') : undefined;
    } catch {
      return undefined;
    }
  }

  private extractUsageMetadata(response: OpenAICompatibleChatResponse | undefined): RecognitionUsageMetadata | undefined {
    try {
      const metadata: RecognitionUsageMetadata = {};
      let hasMetadata = false;
      const setString = (key: 'responseId' | 'responseModel', value: unknown): void => {
        if (typeof value === 'string') {
          metadata[key] = value;
          hasMetadata = true;
        }
      };
      const setCounter = (
        key: Exclude<keyof RecognitionUsageMetadata, 'responseId' | 'responseModel'>,
        value: unknown
      ): void => {
        if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) {
          metadata[key] = value;
          hasMetadata = true;
        }
      };

      setString('responseId', readUntrustedProperty(response, 'id'));
      setString('responseModel', readUntrustedProperty(response, 'model'));

      const usage = readUntrustedProperty(response, 'usage');
      setCounter('promptTokens', readUntrustedProperty(usage, 'prompt_tokens'));
      setCounter('completionTokens', readUntrustedProperty(usage, 'completion_tokens'));
      setCounter('totalTokens', readUntrustedProperty(usage, 'total_tokens'));

      const promptTokenDetails = readUntrustedProperty(usage, 'prompt_tokens_details');
      setCounter('cachedTokens', readUntrustedProperty(promptTokenDetails, 'cached_tokens'));
      setCounter('cacheWriteTokens', readUntrustedProperty(promptTokenDetails, 'cache_write_tokens'));
      setCounter('imageTokens', readUntrustedProperty(promptTokenDetails, 'image_tokens'));
      setCounter('audioTokens', readUntrustedProperty(promptTokenDetails, 'audio_tokens'));
      setCounter('videoTokens', readUntrustedProperty(promptTokenDetails, 'video_tokens'));

      return hasMetadata ? metadata : undefined;
    } catch {
      // Telemetry is optional. Unexpected provider payload shapes must never
      // turn a valid assistant response into a recognition failure.
      return undefined;
    }
  }

  private extractErrorMessage(response: OpenAICompatibleChatResponse | undefined, responseText: string): string {
    const error = readUntrustedProperty(response, 'error');
    const message = readUntrustedProperty(error, 'message');
    const errorText = typeof message === 'string' ? message : responseText;
    return errorText.length > 1000 ? `${errorText.slice(0, 1000)}...` : errorText;
  }
}

function readUntrustedProperty(value: unknown, property: string): unknown {
  if (!value || (typeof value !== 'object' && typeof value !== 'function')) {
    return undefined;
  }

  try {
    return (value as Record<string, unknown>)[property];
  } catch {
    return undefined;
  }
}

function isOpenRouterEndpoint(baseUrl: string): boolean {
  try {
    const hostname = new URL(baseUrl).hostname.toLowerCase();
    return hostname === 'openrouter.ai' || hostname.endsWith('.openrouter.ai');
  } catch {
    return false;
  }
}

export function createRecognitionProvider(config: ResolvedRecognitionConfig): RecognitionProvider {
  if (config.provider === 'gemini') {
    return new GeminiRecognitionProvider(config);
  }

  return new OpenAICompatibleRecognitionProvider(config);
}