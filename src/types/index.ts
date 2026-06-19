/**
 * Type definitions for the MCP server
 */

import { z } from 'zod';
import type { Tool, CallToolResult } from '@modelcontextprotocol/sdk/types.js';

/**
 * Common parameters for all recognition tools
 */
export const RecognitionParamsSchema = z.object({
  filepath: z.string().describe('Path to the media file to analyze'),
  prompt: z.string().default('Describe this content').describe('Custom prompt for the recognition')
});

export type RecognitionParams = z.infer<typeof RecognitionParamsSchema>;

/**
 * Video recognition specific types
 */
export const VideoRecognitionParamsSchema = RecognitionParamsSchema.extend({});
export type VideoRecognitionParams = z.infer<typeof VideoRecognitionParamsSchema>;

/**
 * Image recognition specific types
 */
export const ImageRecognitionParamsSchema = RecognitionParamsSchema.extend({});
export type ImageRecognitionParams = z.infer<typeof ImageRecognitionParamsSchema>;

/**
 * Audio recognition specific types
 */
export const AudioRecognitionParamsSchema = RecognitionParamsSchema.extend({});
export type AudioRecognitionParams = z.infer<typeof AudioRecognitionParamsSchema>;

/**
 * Tool definitions
 */
export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: z.ZodObject<any>;
  callback: (args: any) => Promise<CallToolResult>;
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

export interface RecognitionResult {
  text: string;
  isError?: boolean;
}

export interface RecognitionProvider {
  readonly info: RecognitionProviderInfo;
  recognize(request: RecognitionRequest): Promise<RecognitionResult>;
}

export interface GeminiRecognitionConfig extends RecognitionProviderInfo {
  provider: 'gemini';
  apiKey: string;
}

export interface OpenAICompatibleRecognitionConfig extends RecognitionProviderInfo {
  provider: 'openai-compatible';
  apiKey: string;
  baseUrl: string;
  maxInlineMediaBytes: number;
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
