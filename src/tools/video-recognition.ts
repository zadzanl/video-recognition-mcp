/**
 * Video recognition tool for MCP server
 */

import { createLogger } from '../utils/logger.js';
import { VideoRecognitionParamsSchema } from '../types/index.js';
import { ParallelDispatcher } from '../services/parallel-dispatcher.js';
import type { CallToolResult, ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import type { ParallelInferenceConfig, RecognitionProvider, ToolDefinition, VideoRecognitionParams } from '../types/index.js';

const log = createLogger('VideoRecognitionTool');

const TOOL_ANNOTATIONS: ToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  openWorldHint: true
};

// openWorldHint is true because each call can upload or encode local media and send it to an external provider.

type ParallelDispatch = Pick<ParallelDispatcher, 'dispatch'>;

export const createVideoRecognitionTool = (
  recognitionProvider: RecognitionProvider,
  parallelConfig?: ParallelInferenceConfig,
  parallelDispatcher?: ParallelDispatch
): ToolDefinition<typeof VideoRecognitionParamsSchema> => {
  const baseDescription = `Analyze and describe videos from a local file path using ${recognitionProvider.info.modelName} via ${recognitionProvider.info.providerLabel}. Configure provider credentials in the environment before starting the server. Media can be uploaded or encoded and sent to the external provider endpoint, so latency and provider rate limits can apply. The tool returns plain text, and failures are returned as tool errors. Supported video formats depend on the active provider and model, with common support for MP4, MOV, WEBM, AVI, and MPEG.`;
  const activeParallelDispatcher = resolveParallelDispatcher(parallelConfig, parallelDispatcher);

  return {
    name: 'video_recognition',
    title: 'Video recognition',
    description: buildDescription(baseDescription, parallelConfig),
    annotations: TOOL_ANNOTATIONS,
    inputSchema: VideoRecognitionParamsSchema,
    callback: async (args: VideoRecognitionParams): Promise<CallToolResult> => {
      try {
        log.info(`Processing video recognition request for file: ${args.filepath}`);
        log.verbose('Video recognition request', JSON.stringify(args));
        
        // Default prompt if not provided
        const prompt = args.prompt || 'Describe this video';
        const request = { filepath: args.filepath, prompt, mediaKind: 'video' as const };

        if (activeParallelDispatcher) {
          const result = await activeParallelDispatcher.dispatch(request, recognitionProvider);

          if (result.isError) {
            log.error(`Error in video recognition: ${result.aggregatedText}`);
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

          log.info('Video recognition completed successfully');
          log.verbose('Video recognition result', JSON.stringify(result));

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
