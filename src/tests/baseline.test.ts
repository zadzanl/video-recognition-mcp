/**
 * status: active
 * phase: checkpoint-2-baseline-characterization
 * sprint: provider-foundation-first-sprint
 * last_modified: 2026-08-02
 * agent_notes: "Characterizes existing tool contracts through credential-free GeminiService fakes."
 * insights: "Current schemas own the shared omitted-prompt default; tool callbacks preserve three distinct MCP error prefixes."
 */

import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAudioRecognitionTool } from '../tools/audio-recognition.js';
import { createImageRecognitionTool } from '../tools/image-recognition.js';
import { createVideoRecognitionTool } from '../tools/video-recognition.js';
import type { GeminiService } from '../services/gemini.js';
import type { GeminiFile, GeminiResponse } from '../types/index.js';

const temporaryDirectory = await mkdtemp(join(tmpdir(), 'media-processing-baseline-'));

after(async () => {
  await rm(temporaryDirectory, { recursive: true, force: true });
});

interface FakeCalls {
  uploadedPaths: string[];
  processed: {
    file: GeminiFile;
    prompt: string;
    modelName: string;
  }[];
}

interface FakeBehavior {
  processResult?: GeminiResponse;
  uploadError?: Error;
}

const createFakeService = (behavior: FakeBehavior = {}): {
  service: GeminiService;
  calls: FakeCalls;
} => {
  const calls: FakeCalls = {
    uploadedPaths: [],
    processed: []
  };
  const uploadedFile: GeminiFile = {
    uri: 'gemini://fixture',
    mimeType: 'application/octet-stream',
    name: 'fixture'
  };

  const service = {
    uploadFile: async (filepath: string): Promise<GeminiFile> => {
      calls.uploadedPaths.push(filepath);
      if (behavior.uploadError) {
        throw behavior.uploadError;
      }
      return uploadedFile;
    },
    processFile: async (
      file: GeminiFile,
      prompt: string,
      modelName: string
    ): Promise<GeminiResponse> => {
      calls.processed.push({ file, prompt, modelName });
      return behavior.processResult ?? { text: 'recognized fixture' };
    }
  } as unknown as GeminiService;

  return { service, calls };
};

const toolCases = [
  {
    name: 'image_recognition',
    mediaLabel: 'image',
    extension: '.png',
    createTool: createImageRecognitionTool
  },
  {
    name: 'audio_recognition',
    mediaLabel: 'audio',
    extension: '.wav',
    createTool: createAudioRecognitionTool
  },
  {
    name: 'video_recognition',
    mediaLabel: 'video',
    extension: '.mp4',
    createTool: createVideoRecognitionTool
  }
] as const;

test('recognition tools retain exact names and input keys', () => {
  for (const toolCase of toolCases) {
    const { service } = createFakeService();
    const tool = toolCase.createTool(service);

    assert.equal(tool.name, toolCase.name);
    assert.deepEqual(
      Object.keys(tool.inputSchema.shape).sort(),
      ['filepath', 'modelname', 'prompt']
    );
  }
});

test('schemas default an omitted prompt to exactly Describe this content', () => {
  for (const toolCase of toolCases) {
    const { service } = createFakeService();
    const tool = toolCase.createTool(service);
    const parsed = tool.inputSchema.parse({ filepath: `fixture${toolCase.extension}` });

    assert.equal(parsed.prompt, 'Describe this content');
  }
});

test('tools forward explicit prompt and model and retain success envelopes', async () => {
  for (const [index, toolCase] of toolCases.entries()) {
    const filepath = join(temporaryDirectory, `success-${index}${toolCase.extension}`);
    await writeFile(filepath, 'fixture');
    const { service, calls } = createFakeService({
      processResult: { text: `${toolCase.mediaLabel} success` }
    });
    const tool = toolCase.createTool(service);
    const args = tool.inputSchema.parse({
      filepath,
      prompt: `${toolCase.mediaLabel} prompt`,
      modelname: `${toolCase.mediaLabel} model`
    });

    const result = await tool.callback(args);

    assert.deepEqual(calls.uploadedPaths, [filepath]);
    assert.equal(calls.processed.length, 1);
    assert.equal(calls.processed[0]?.prompt, `${toolCase.mediaLabel} prompt`);
    assert.equal(calls.processed[0]?.modelName, `${toolCase.mediaLabel} model`);
    assert.deepEqual(result, {
      content: [{ type: 'text', text: `${toolCase.mediaLabel} success` }]
    });
  }
});

test('tools retain Gemini service-error MCP envelopes', async () => {
  for (const [index, toolCase] of toolCases.entries()) {
    const filepath = join(temporaryDirectory, `service-error-${index}${toolCase.extension}`);
    await writeFile(filepath, 'fixture');
    const { service } = createFakeService({
      processResult: { text: `${toolCase.mediaLabel} service error`, isError: true }
    });
    const tool = toolCase.createTool(service);
    const args = tool.inputSchema.parse({ filepath });

    const result = await tool.callback(args);

    assert.deepEqual(result, {
      content: [{ type: 'text', text: `${toolCase.mediaLabel} service error` }],
      isError: true
    });
  }
});

test('tools retain thrown-error MCP envelopes', async () => {
  for (const [index, toolCase] of toolCases.entries()) {
    const filepath = join(temporaryDirectory, `thrown-error-${index}${toolCase.extension}`);
    await writeFile(filepath, 'fixture');
    const { service } = createFakeService({
      uploadError: new Error(`${toolCase.mediaLabel} upload failed`)
    });
    const tool = toolCase.createTool(service);
    const args = tool.inputSchema.parse({ filepath });

    const result = await tool.callback(args);

    assert.deepEqual(result, {
      content: [{
        type: 'text',
        text: `Error processing ${toolCase.mediaLabel}: ${toolCase.mediaLabel} upload failed`
      }],
      isError: true
    });
  }
});