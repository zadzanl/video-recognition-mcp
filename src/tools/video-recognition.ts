/**
 * Video recognition tool for MCP server
 * status: active
 * phase: phase-5-tool-server-wiring
 * sprint: provider-foundation-first-sprint
 * last_modified: 2026-08-06
 * agent_notes: "Tool boundary is provider-neutral; file and format validation moved into provider adapters."
 * insights: "Schema owns the sole prompt default; providers throw ProviderFailure instead of returning isError envelopes. Cause values never cross the MCP boundary."
 */

import { createLogger } from '../utils/logger.js';
import { isProviderFailure } from '../services/provider-failure.js';
import { VideoRecognitionParamsSchema } from '../types/index.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { VideoRecognitionParams } from '../types/index.js';
import type { RecognitionProvider, RecognitionRequest } from '../types/provider.js';

const log = createLogger('VideoRecognitionTool');

export const createVideoRecognitionTool = (provider: RecognitionProvider) => {
  return {
    name: 'video_recognition',
    description: 'Analyze and describe videos using Google Gemini AI',
    inputSchema: VideoRecognitionParamsSchema,
    callback: async (args: VideoRecognitionParams, extra: { signal: AbortSignal }): Promise<CallToolResult> => {
      try {
        log.info(`Processing video recognition request for file: ${args.filepath}`);
        log.verbose('Video recognition request', JSON.stringify(args));

        const request: RecognitionRequest = {
          filepath: args.filepath,
          prompt: args.prompt,
          mediaKind: 'video',
          model: args.modelname
        };

        log.info('Generating content from video...');
        const result = await provider.recognize(request, { signal: extra.signal });

        log.info('Video recognition completed successfully');
        log.verbose('Video recognition result', JSON.stringify(result));

        return {
          content: [
            {
              type: 'text',
              text: result.text
            }
          ]
        };
      } catch (error) {
        log.error('Error in video recognition tool', error);
        const errorMessage = isProviderFailure(error)
          ? error.safeMessage
          : error instanceof Error ? error.message : String(error);

        return {
          content: [
            {
              type: 'text',
              text: `Error processing video: ${errorMessage}`
            }
          ],
          isError: true
        };
      }
    }
  };
};
