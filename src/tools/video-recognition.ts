/**
 * Video recognition tool for MCP server
 */

import { createLogger } from '../utils/logger.js';
import { VideoRecognitionParamsSchema } from '../types/index.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { RecognitionProvider, VideoRecognitionParams } from '../types/index.js';

const log = createLogger('VideoRecognitionTool');

export const createVideoRecognitionTool = (recognitionProvider: RecognitionProvider) => {
  return {
    name: 'video_recognition',
    description: `Analyze and describe videos. This tool uses ${recognitionProvider.info.modelName} via ${recognitionProvider.info.providerLabel} to parse and explain video content.`,
    inputSchema: VideoRecognitionParamsSchema,
    callback: async (args: VideoRecognitionParams): Promise<CallToolResult> => {
      try {
        log.info(`Processing video recognition request for file: ${args.filepath}`);
        log.verbose('Video recognition request', JSON.stringify(args));
        
        // Default prompt if not provided
        const prompt = args.prompt || 'Describe this video';
        const result = await recognitionProvider.recognize({ filepath: args.filepath, prompt, mediaKind: 'video' });
        
        if (result.isError) {
          log.error(`Error in video recognition: ${result.text}`);
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
        const errorMessage = error instanceof Error ? error.message : String(error);
        
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
