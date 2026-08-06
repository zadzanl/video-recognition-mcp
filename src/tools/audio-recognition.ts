/**
 * Audio recognition tool for MCP server
 * status: active
 * phase: phase-5-tool-server-wiring
 * sprint: provider-foundation-first-sprint
 * last_modified: 2026-08-06
 * agent_notes: "Tool boundary is provider-neutral; file and format validation moved into provider adapters."
 * insights: "Schema owns the sole prompt default; providers throw ProviderFailure instead of returning isError envelopes. Cause values never cross the MCP boundary."
 */

import { createLogger } from '../utils/logger.js';
import { isProviderFailure } from '../services/provider-failure.js';
import { AudioRecognitionParamsSchema } from '../types/index.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { AudioRecognitionParams } from '../types/index.js';
import type { RecognitionProvider, RecognitionRequest } from '../types/provider.js';

const log = createLogger('AudioRecognitionTool');

export const createAudioRecognitionTool = (provider: RecognitionProvider) => {
  return {
    name: 'audio_recognition',
    description: 'Analyze and transcribe audio using the configured recognition provider',
    inputSchema: AudioRecognitionParamsSchema,
    callback: async (args: AudioRecognitionParams, extra: { signal: AbortSignal }): Promise<CallToolResult> => {
      try {
        log.info(`Processing audio recognition request for file: ${args.filepath}`);
        log.verbose('Audio recognition request', JSON.stringify(args));

        const request: RecognitionRequest = {
          filepath: args.filepath,
          prompt: args.prompt,
          mediaKind: 'audio',
          model: args.modelname
        };

        log.info('Generating content from audio...');
        const result = await provider.recognize(request, { signal: extra.signal });

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
        const errorMessage = isProviderFailure(error)
          ? error.safeMessage
          : error instanceof Error ? error.message : String(error);

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
