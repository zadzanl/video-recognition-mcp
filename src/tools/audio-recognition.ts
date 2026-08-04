/**
 * Audio recognition tool for MCP server
 * status: active
 * phase: checkpoint-3-schema-default-ownership
 * sprint: provider-foundation-first-sprint
 * last_modified: 2026-08-02
 * agent_notes: "Forwards parsed prompt/model values directly to the retained GeminiService seam."
 * insights: "Schema owns the sole prompt default; provider rewiring remains deferred."
 */

import { createLogger } from '../utils/logger.js';
import { GeminiService } from '../services/gemini.js';
import { AudioRecognitionParamsSchema } from '../types/index.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { AudioRecognitionParams } from '../types/index.js';
import * as fs from 'node:fs';
import * as path from 'node:path';

const log = createLogger('AudioRecognitionTool');

export const createAudioRecognitionTool = (geminiService: GeminiService) => {
  return {
    name: 'audio_recognition',
    description: 'Analyze and transcribe audio using Google Gemini AI',
    inputSchema: AudioRecognitionParamsSchema,
    callback: async (args: AudioRecognitionParams): Promise<CallToolResult> => {
      try {
        log.info(`Processing audio recognition request for file: ${args.filepath}`);
        log.verbose('Audio recognition request', JSON.stringify(args));
        
        // Verify file exists
        if (!fs.existsSync(args.filepath)) {
          throw new Error(`Audio file not found: ${args.filepath}`);
        }
        
        // Verify file is an audio
        const ext = path.extname(args.filepath).toLowerCase();
        if (!['.mp3', '.wav', '.ogg'].includes(ext)) {
          throw new Error(`Unsupported audio format: ${ext}. Supported formats are: .mp3, .wav, .ogg`);
        }
        
        // Upload the file
        log.info('Uploading audio file...');
        const file = await geminiService.uploadFile(args.filepath);
        
        // Process with Gemini
        log.info('Generating content from audio...');
        const result = await geminiService.processFile(file, args.prompt, args.modelname);
        
        if (result.isError) {
          log.error(`Error in audio recognition: ${result.text}`);
          return {
            content: [
              {
                type: 'text',
                text: result.text
              }
            ],
            isError: true
          };
        }
        
        log.info('Audio recognition completed successfully');
        log.verbose('Audio recognition result', JSON.stringify(result));
        
        return {
          content: [
            {
              type: 'text',
              text: result.text
            }
          ]
        };
      } catch (error) {
        log.error('Error in audio recognition tool', error);
        const errorMessage = error instanceof Error ? error.message : String(error);
        
        return {
          content: [
            {
              type: 'text',
              text: `Error processing audio: ${errorMessage}`
            }
          ],
          isError: true
        };
      }
    }
  };
};
