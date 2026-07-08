/**
 * Image recognition tool for MCP server
 */

import { createLogger } from '../utils/logger.js';
import { ImageRecognitionParamsSchema } from '../types/index.js';
import { ParallelDispatcher } from '../services/parallel-dispatcher.js';
import type { CallToolResult, ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import type { ImageRecognitionParams, ParallelInferenceConfig, RecognitionProvider, ToolDefinition } from '../types/index.js';

const log = createLogger('ImageRecognitionTool');

const TOOL_ANNOTATIONS: ToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  openWorldHint: true
};

// openWorldHint is true because each call can upload or encode local media and send it to an external provider.

type ParallelDispatch = Pick<ParallelDispatcher, 'dispatch'>;

export const createImageRecognitionTool = (
  recognitionProvider: RecognitionProvider,
  parallelConfig?: ParallelInferenceConfig,
  parallelDispatcher?: ParallelDispatch
): ToolDefinition<typeof ImageRecognitionParamsSchema> => {
  const baseDescription = `Analyze and describe images from a local file path using ${recognitionProvider.info.modelName} via ${recognitionProvider.info.providerLabel}. Configure provider credentials in the environment before starting the server. Media can be uploaded or encoded and sent to the external provider endpoint, so latency and provider rate limits can apply. The tool returns plain text, and failures are returned as tool errors. Supported image formats depend on the active provider and model, with common support for JPG, JPEG, PNG, and WEBP.`;
  const activeParallelDispatcher = resolveParallelDispatcher(parallelConfig, parallelDispatcher);

  return {
    name: 'image_recognition',
    title: 'Image recognition',
    description: buildDescription(baseDescription, parallelConfig),
    annotations: TOOL_ANNOTATIONS,
    inputSchema: ImageRecognitionParamsSchema,
    callback: async (args: ImageRecognitionParams): Promise<CallToolResult> => {
      try {
        log.info(`Processing image recognition request for file: ${args.filepath}`);
        log.verbose('Image recognition request', JSON.stringify(args));
        
        // Default prompt if not provided
        const prompt = args.prompt || 'Describe this image';
        const request = { filepath: args.filepath, prompt, mediaKind: 'image' as const };

        if (activeParallelDispatcher) {
          const result = await activeParallelDispatcher.dispatch(request, recognitionProvider);

          if (result.isError) {
            log.error(`Error in image recognition: ${result.aggregatedText}`);
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

          log.info('Image recognition completed successfully');
          log.verbose('Image recognition result', JSON.stringify(result));

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
