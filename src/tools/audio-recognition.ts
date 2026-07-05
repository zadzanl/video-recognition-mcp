/**
 * Audio recognition tool for MCP server
 */

import { createLogger } from '../utils/logger.js';
import { AudioRecognitionParamsSchema } from '../types/index.js';
import { ParallelDispatcher } from '../services/parallel-dispatcher.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { AudioRecognitionParams, ParallelInferenceConfig, RecognitionProvider } from '../types/index.js';

const log = createLogger('AudioRecognitionTool');

type ParallelDispatch = Pick<ParallelDispatcher, 'dispatch'>;

export const createAudioRecognitionTool = (
  recognitionProvider: RecognitionProvider,
  parallelConfig?: ParallelInferenceConfig,
  parallelDispatcher?: ParallelDispatch
) => {
  const baseDescription = `Analyze and transcribe audio. This tool uses ${recognitionProvider.info.modelName} via ${recognitionProvider.info.providerLabel} to parse and explain audio content.`;
  const activeParallelDispatcher = resolveParallelDispatcher(parallelConfig, parallelDispatcher);

  return {
    name: 'audio_recognition',
    description: buildDescription(baseDescription, parallelConfig),
    inputSchema: AudioRecognitionParamsSchema,
    callback: async (args: AudioRecognitionParams): Promise<CallToolResult> => {
      try {
        log.info(`Processing audio recognition request for file: ${args.filepath}`);
        log.verbose('Audio recognition request', JSON.stringify(args));
        
        // Default prompt if not provided
        const prompt = args.prompt || 'Describe this audio';
        const request = { filepath: args.filepath, prompt, mediaKind: 'audio' as const };

        if (activeParallelDispatcher) {
          const result = await activeParallelDispatcher.dispatch(request, recognitionProvider);

          if (result.isError) {
            log.error(`Error in audio recognition: ${result.aggregatedText}`);
            return {
              content: [
                {
                  type: 'text',
                  text: result.aggregatedText
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
                text: result.aggregatedText
              }
            ]
          };
        }

        const result = await recognitionProvider.recognize(request);
        
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

function resolveParallelDispatcher(
  parallelConfig: ParallelInferenceConfig | undefined,
  parallelDispatcher: ParallelDispatch | undefined
): ParallelDispatch | undefined {
  if (!isParallelDispatchEnabled(parallelConfig)) {
    return undefined;
  }

  return parallelDispatcher ?? new ParallelDispatcher(parallelConfig);
}

function buildDescription(baseDescription: string, parallelConfig: ParallelInferenceConfig | undefined): string {
  if (!isParallelDispatchEnabled(parallelConfig)) {
    return baseDescription;
  }

  return `${baseDescription} This tool dispatches ${parallelConfig.promptCount} parallel prompt variants per call for improved recognition quality (aggregation: ${parallelConfig.aggregation}).`;
}

function isParallelDispatchEnabled(parallelConfig: ParallelInferenceConfig | undefined): parallelConfig is ParallelInferenceConfig {
  return Boolean(parallelConfig?.enabled && parallelConfig.promptCount > 1);
}
