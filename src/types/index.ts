/**
 * Type definitions for the MCP server
 */

import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

/**
 * Common parameters for all recognition tools
 */
export const RecognitionParamsSchema = z.object({
  filepath: z.string().describe('Path to the media file to analyze'),
  prompt: z.string().default('Describe this content').describe('Custom prompt for the recognition')
});

export type RecognitionParams = z.input<typeof RecognitionParamsSchema>;

/**
 * Video recognition specific types
 */
export const VideoRecognitionParamsSchema = RecognitionParamsSchema.extend({});
export type VideoRecognitionParams = z.input<typeof VideoRecognitionParamsSchema>;

/**
 * Image recognition specific types
 */
export const ImageRecognitionParamsSchema = RecognitionParamsSchema.extend({});
export type ImageRecognitionParams = z.input<typeof ImageRecognitionParamsSchema>;

/**
 * Audio recognition specific types
 */
export const AudioRecognitionParamsSchema = RecognitionParamsSchema.extend({});
export type AudioRecognitionParams = z.input<typeof AudioRecognitionParamsSchema>;

/**
 * Tool definitions
 */
export interface ToolDefinition<TInputSchema extends z.AnyZodObject = typeof RecognitionParamsSchema> {
  name: string;
  description: string;
  inputSchema: TInputSchema;
  callback: (args: z.input<TInputSchema>) => Promise<CallToolResult>;
}

/**
 * Provider-neutral recognition types
 */
export type RecognitionProviderName = 'gemini' | 'openai-compatible';

export type MediaKind = 'image' | 'audio' | 'video';

export interface RecognitionProviderInfo {
  provider: RecognitionProviderName;
  providerLabel: string;
  modelName: string;
}

export interface RecognitionRequest {
  filepath: string;
  prompt: string;
  mediaKind: MediaKind;
}

export type OpenRouterResponseCacheConfig = boolean | undefined;

export interface PromptLayoutMetadata {
  stableTextPrefix: string;
  variableTextSuffix?: string;
}

export interface ProviderCallOptions {
  sessionId?: string;
  stableInstruction?: {
    role: 'system' | 'developer';
    text: string;
  };
  promptLayout?: PromptLayoutMetadata;
}

export interface RecognitionResult {
  text: string;
  isError?: boolean;
}

export interface RecognitionProvider {
  readonly info: RecognitionProviderInfo;
  recognize(request: RecognitionRequest, options?: ProviderCallOptions): Promise<RecognitionResult>;
  /** Optional internal text-only synthesis path used by llm_merge aggregation. */
  synthesizeText?(prompt: string, options?: ProviderCallOptions): Promise<RecognitionResult>;
}

/**
 * Parallel ensemble inference types
 */
export type ParallelAggregationMode = 'all_return' | 'header_merge' | 'llm_merge';

export interface PromptTemplate {
  name: string;
  suffix: string;
}

export interface ParallelInferenceConfig {
  enabled: boolean;
  promptCount: number;
  aggregation: ParallelAggregationMode;
  promptTemplates: PromptTemplate[];
  headerMergeTemplate: string;
  llmMergePrompt: string;
}

export interface ParallelPromptVariant {
  index: number;
  prompt: string;
  templateName: string;
  promptLayout: PromptLayoutMetadata;
}

export interface ParallelVariantResult {
  index: number;
  status: 'success' | 'failed';
  templateName: string;
  result?: RecognitionResult;
  errorMessage?: string;
}

export interface ParallelDispatchResult {
  aggregatedText: string;
  variants: ParallelVariantResult[];
  dispatchedCount: number;
  succeededCount: number;
  failedCount: number;
  aggregation: ParallelAggregationMode;
  isError?: boolean;
}

export interface GeminiRecognitionConfig extends RecognitionProviderInfo {
  provider: 'gemini';
  apiKey: string;
  /** Ordered list of model IDs for fallback. First is primary. */
  modelNames: string[];
  openRouterApiKey?: string;
  openRouterModels?: string[];
  openRouterResponseCache?: OpenRouterResponseCacheConfig;
  mimoApiKey?: string;
  mimoModels?: string[];
  mimoBaseUrl?: string;
  rateLimitMaxWaitMs?: number;
  parallelInference: ParallelInferenceConfig;
}

export interface OpenAICompatibleRecognitionConfig extends RecognitionProviderInfo {
  provider: 'openai-compatible';
  apiKey: string;
  baseUrl: string;
  maxInlineMediaBytes: number;
  openRouterResponseCache?: OpenRouterResponseCacheConfig;
  parallelInference: ParallelInferenceConfig;
}

export type ResolvedRecognitionConfig = GeminiRecognitionConfig | OpenAICompatibleRecognitionConfig;

/**
 * Gemini API types
 */
export interface GeminiConfig {
  apiKey: string;
}

export interface GeminiFile {
  uri: string;
  mimeType: string;
  name?: string;
  state?: string;
}

export interface ProcessedGeminiFile {
  uri: string;
  mimeType: string;
  name: string;
  state: string;
}

export interface CachedFile {
  fileId: string;
  checksum: string;
  uri: string;
  mimeType: string;
  name: string;
  state: string;
  timestamp: number;
}

// File states from Gemini API
export enum FileState {
  UNSPECIFIED = 'STATE_UNSPECIFIED',
  PROCESSING = 'PROCESSING',
  ACTIVE = 'ACTIVE',
  FAILED = 'FAILED'
}

export interface GeminiResponse {
  text: string;
  isError?: boolean;
}
