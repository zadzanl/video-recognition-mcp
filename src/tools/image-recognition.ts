/**
 * Image recognition tool for MCP server
 */

import { createLogger } from '../utils/logger.js';
import { ImageRecognitionParamsSchema } from '../types/index.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { ImageRecognitionParams, RecognitionProvider } from '../types/index.js';

const log = createLogger('ImageRecognitionTool');

export const createImageRecognitionTool = (recognitionProvider: RecognitionProvider) => {
  return {
    name: 'image_recognition',
    description: `Analyze and describe images. This tool uses ${recognitionProvider.info.modelName} via ${recognitionProvider.info.providerLabel} to parse and explain image content.`,
    inputSchema: ImageRecognitionParamsSchema,
    callback: async (args: ImageRecognitionParams): Promise<CallToolResult> => {
      try {
        log.info(`Processing image recognition request for file: ${args.filepath}`);
        log.verbose('Image recognition request', JSON.stringify(args));
        
        // Default prompt if not provided
        const prompt = args.prompt || 'Describe this image';
        const result = await recognitionProvider.recognize({ filepath: args.filepath, prompt, mediaKind: 'image' });
        
        if (result.isError) {
          log.error(`Error in image recognition: ${result.text}`);
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
        
        log.info('Image recognition completed successfully');
        log.verbose('Image recognition result', JSON.stringify(result));
        
        return {
          content: [
            {
              type: 'text',
              text: result.text
            }
          ]
        };
      } catch (error) {
        log.error('Error in image recognition tool', error);
        const errorMessage = error instanceof Error ? error.message : String(error);
        
        return {
          content: [
            {
              type: 'text',
              text: `Error processing image: ${errorMessage}`
            }
          ],
          isError: true
        };
      }
    }
  };
};
