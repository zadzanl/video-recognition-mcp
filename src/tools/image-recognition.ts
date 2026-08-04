/**
 * Image recognition tool for MCP server
 * status: active
 * phase: checkpoint-3-schema-default-ownership
 * sprint: provider-foundation-first-sprint
 * last_modified: 2026-08-02
 * agent_notes: "Forwards parsed prompt/model values directly to the retained GeminiService seam."
 * insights: "Schema owns the sole prompt default; provider rewiring remains deferred."
 */

import { createLogger } from '../utils/logger.js';
import { GeminiService } from '../services/gemini.js';
import { ImageRecognitionParamsSchema } from '../types/index.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { ImageRecognitionParams } from '../types/index.js';
import * as fs from 'node:fs';
import * as path from 'node:path';

const log = createLogger('ImageRecognitionTool');

export const createImageRecognitionTool = (geminiService: GeminiService) => {
  return {
    name: 'image_recognition',
    description: 'Analyze and describe images using Google Gemini AI',
    inputSchema: ImageRecognitionParamsSchema,
    callback: async (args: ImageRecognitionParams): Promise<CallToolResult> => {
      try {
        log.info(`Processing image recognition request for file: ${args.filepath}`);
        log.verbose('Image recognition request', JSON.stringify(args));
        
        // Verify file exists
        if (!fs.existsSync(args.filepath)) {
          throw new Error(`Image file not found: ${args.filepath}`);
        }
        
        // Verify file is an image
        const ext = path.extname(args.filepath).toLowerCase();
        if (!['.jpg', '.jpeg', '.png', '.webp'].includes(ext)) {
          throw new Error(`Unsupported image format: ${ext}. Supported formats are: .jpg, .jpeg, .png, .webp`);
        }
        
        // Upload the file
        log.info('Uploading image file...');
        const file = await geminiService.uploadFile(args.filepath);
        
        // Process with Gemini
        log.info('Generating content from image...');
        const result = await geminiService.processFile(file, args.prompt, args.modelname);
        
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
