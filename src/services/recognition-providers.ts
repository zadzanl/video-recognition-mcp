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

const log = createLogger('RecognitionProviders');

export class GeminiRecognitionProvider implements RecognitionProvider {
  readonly info;
  private readonly geminiService: GeminiService;

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

    // Upload / cache lookup once before the model attempt loop.
    const file = await this.geminiService.uploadFile(request.filepath);

    const attempted: Array<{ model: string; reason: string }> = [];

    for (const modelName of this.config.modelNames) {
      try {
        log.info(`Attempting Gemini generation with model ${modelName}`);
        const result = await this.geminiService.processFile(file, request.prompt, modelName);

        // Success
        if (attempted.length > 0) {
          log.info(`Gemini fallback succeeded with model ${modelName} after attempting ${attempted.map(a => a.model).join(', ')}`);
        } else {
          log.info(`Gemini generation succeeded with primary model ${modelName}`);
        }
        return result;
      } catch (error) {
        const classification: ErrorClassification = classifyGeminiError(error);
        log.warn(`Gemini model ${modelName} failed: ${classification.reason}`);

        if (!classification.retryable) {
          // Fail-fast: do not attempt further models.
          log.error(`Gemini fail-fast error on model ${modelName}: ${classification.reason}`);
          return {
            text: `Gemini generation failed: ${classification.reason}`,
            isError: true
          };
        }

        // Fallback-eligible: record and try next model.
        attempted.push({ model: modelName, reason: classification.reason });
      }
    }

    // Exhausted all configured models.
    const modelList = attempted.map(a => `${a.model} (${a.reason})`).join(', ');
    log.error(`Gemini model fallback exhausted. Attempted: ${modelList}`);
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