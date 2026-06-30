/**
 * Recognition provider factory and provider implementations.
 */

import { createLogger } from '../utils/logger.js';
import type {
  GeminiRecognitionConfig,
  OpenAICompatibleRecognitionConfig,
  RecognitionProvider,
  RecognitionRequest,
  RecognitionResult,
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

function classifyOpenAiError(message: string): { retryable: boolean; reason: string } {
  const msg = message.toUpperCase();
  if (/401|UNAUTHORIZED|INVALID API KEY|INVALID_API_KEY/i.test(msg)) {
    return { retryable: false, reason: 'unauthenticated' };
  }
  if (/403|FORBIDDEN|PERMISSION_DENIED/i.test(msg)) {
    return { retryable: false, reason: 'permission denied' };
  }
  if (/400|INVALID_ARGUMENT|INVALID_REQUEST|MALFORMED|UNSUPPORTED/i.test(msg)) {
    return { retryable: false, reason: 'invalid request/argument' };
  }
  if (/429|RATE LIMIT|TOO MANY REQUESTS|RESOURCE_EXHAUSTED/i.test(msg)) {
    return { retryable: true, reason: 'rate limited (429)' };
  }
  if (/500|INTERNAL SERVER/i.test(msg)) {
    return { retryable: true, reason: 'internal server error (500)' };
  }
  if (/503|SERVICE UNAVAILABLE/i.test(msg)) {
    return { retryable: true, reason: 'service unavailable (503)' };
  }
  if (/TIMEOUT|DEADLINE_EXCEEDED|ABORTED|ETIMEDOUT|ECONNRESET/i.test(msg)) {
    return { retryable: true, reason: 'timeout or connection reset' };
  }
  // Safe default for general errors is fail-fast
  return { retryable: false, reason: message };
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

  async recognize(request: RecognitionRequest): Promise<RecognitionResult> {
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

    const attempted: Array<{ model: string; reason: string }> = [];
    let geminiFile: any = null;

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
            maxInlineMediaBytes: DEFAULT_MAX_INLINE_MEDIA_BYTES
          };
          const provider = new OpenAICompatibleRecognitionProvider(openRouterConfig);
          const result = await provider.recognize(request);
          if (result.isError) {
            const classification = classifyOpenAiError(result.text);
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
            maxInlineMediaBytes: DEFAULT_MAX_INLINE_MEDIA_BYTES
          };
          const provider = new OpenAICompatibleRecognitionProvider(mimoConfig);
          const result = await provider.recognize(request);
          if (result.isError) {
            const classification = classifyOpenAiError(result.text);
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
}

interface OpenAICompatibleMessageContentPart {
  type: string;
  text?: string;
  image_url?: { url: string };
  video_url?: { url: string };
  input_audio?: { data: string; format: string };
}

interface OpenAICompatibleChatResponse {
  choices?: Array<{
    message?: {
      content?: string | Array<{ type?: string; text?: string }>;
    };
  }>;
  error?: {
    message?: string;
  };
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

  async recognize(request: RecognitionRequest): Promise<RecognitionResult> {
    try {
      const media = await validateMediaFile(this.info.providerLabel, this.info.provider, request.mediaKind, request.filepath);

      let mediaPart: OpenAICompatibleMessageContentPart;
      if (request.mediaKind === 'audio') {
        const rawBase64 = await createRawBase64(media, this.config.maxInlineMediaBytes);
        const format = audioFormatFromExtension(media.extension);
        mediaPart = this.createAudioMediaPart(rawBase64, format);
      } else {
        const dataUrl = await createBase64DataUrl(media, this.config.maxInlineMediaBytes);
        mediaPart = this.createMediaPart(request.mediaKind, dataUrl);
      }

      log.debug(`Sending ${request.mediaKind} recognition request to ${this.info.providerLabel} using model ${this.info.modelName}`);

      const response = await fetch(this.chatCompletionsUrl, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.config.apiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: this.config.modelName,
          messages: [
            {
              role: 'user',
              content: [
                { type: 'text', text: request.prompt },
                mediaPart
              ]
            }
          ]
        })
      });

      const responseText = await response.text();
      const parsed = this.parseJsonResponse(responseText);

      if (!response.ok) {
        return {
          text: `${this.info.providerLabel} API error (${response.status} ${response.statusText}): ${this.extractErrorMessage(parsed, responseText)}`,
          isError: true
        };
      }

      const text = this.extractAssistantText(parsed);
      if (!text) {
        return {
          text: `${this.info.providerLabel} returned an unsupported or empty chat completion response shape`,
          isError: true
        };
      }

      return { text };
    } catch (error) {
      return {
        text: `Error processing file with ${this.info.providerLabel}: ${error instanceof Error ? error.message : String(error)}`,
        isError: true
      };
    }
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

  private parseJsonResponse(responseText: string): OpenAICompatibleChatResponse | undefined {
    try {
      return JSON.parse(responseText) as OpenAICompatibleChatResponse;
    } catch {
      return undefined;
    }
  }

  private extractAssistantText(response: OpenAICompatibleChatResponse | undefined): string | undefined {
    const content = response?.choices?.[0]?.message?.content;
    if (typeof content === 'string') {
      return content;
    }

    if (Array.isArray(content)) {
      return content
        .map(part => part.text)
        .filter((text): text is string => Boolean(text))
        .join('\n');
    }

    return undefined;
  }

  private extractErrorMessage(response: OpenAICompatibleChatResponse | undefined, responseText: string): string {
    const message = response?.error?.message || responseText;
    return message.length > 1000 ? `${message.slice(0, 1000)}...` : message;
  }
}

export function createRecognitionProvider(config: ResolvedRecognitionConfig): RecognitionProvider {
  if (config.provider === 'gemini') {
    return new GeminiRecognitionProvider(config);
  }

  return new OpenAICompatibleRecognitionProvider(config);
}