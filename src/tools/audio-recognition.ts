/**
 * Audio recognition tool for MCP server
 */

import { createLogger } from '../utils/logger.js';
import { AudioRecognitionParamsSchema } from '../types/index.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { AudioRecognitionParams, RecognitionProvider } from '../types/index.js';

const log = createLogger('AudioRecognitionTool');

export const createAudioRecognitionTool = (recognitionProvider: RecognitionProvider) => {
  return {
    name: 'audio_recognition',
    description: `Analyze and transcribe audio. This tool uses ${recognitionProvider.info.modelName} via ${recognitionProvider.info.providerLabel} to parse and explain audio content.`,
    inputSchema: AudioRecognitionParamsSchema,
    callback: async (args: AudioRecognitionParams): Promise<CallToolResult> => {
      try {
        log.info(`Processing audio recognition request for file: ${args.filepath}`);
        log.verbose('Audio recognition request', JSON.stringify(args));
        
        // Default prompt if not provided
        const prompt = args.prompt || 'Describe this audio';
        const result = await recognitionProvider.recognize({ filepath: args.filepath, prompt, mediaKind: 'audio' });
        
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
