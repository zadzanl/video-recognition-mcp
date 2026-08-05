/**
 * status: active
 * phase: phase-5-tool-server-wiring
 * sprint: provider-foundation-first-sprint
 * last_modified: 2026-08-06
 * agent_notes: "Fake-provider contract tests for the tool boundary after Phase 5 provider injection."
 * insights: "Each tool must call recognize exactly once per invocation, forward the caller abort signal, and map failures without leaking cause values into MCP results."
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createAudioRecognitionTool } from '../tools/audio-recognition.js';
import { createImageRecognitionTool } from '../tools/image-recognition.js';
import { createVideoRecognitionTool } from '../tools/video-recognition.js';
import { createProviderFailure } from '../services/provider-failure.js';
import type {
  MediaKind,
  ProviderCallOptions,
  RecognitionProvider,
  RecognitionRequest,
  RecognitionResult
} from '../types/provider.js';

interface RecordedCall {
  request: RecognitionRequest;
  options: ProviderCallOptions | undefined;
}

interface FakeBehavior {
  result?: RecognitionResult;
  failure?: Error;
}

const createRecordingProvider = (behavior: FakeBehavior = {}): {
  provider: RecognitionProvider;
  calls: RecordedCall[];
} => {
  const calls: RecordedCall[] = [];

  const provider: RecognitionProvider = {
    recognize: async (
      request: RecognitionRequest,
      options?: ProviderCallOptions
    ): Promise<RecognitionResult> => {
      calls.push({ request, options });
      if (behavior.failure) {
        throw behavior.failure;
      }
      return behavior.result ?? { text: 'recognized fixture' };
    }
  };

  return { provider, calls };
};

const toolCases = [
  {
    name: 'image_recognition',
    mediaLabel: 'image',
    mediaKind: 'image' as MediaKind,
    createTool: createImageRecognitionTool
  },
  {
    name: 'audio_recognition',
    mediaLabel: 'audio',
    mediaKind: 'audio' as MediaKind,
    createTool: createAudioRecognitionTool
  },
  {
    name: 'video_recognition',
    mediaLabel: 'video',
    mediaKind: 'video' as MediaKind,
    createTool: createVideoRecognitionTool
  }
] as const;

test('each tool calls provider.recognize exactly once per invocation', async () => {
  for (const toolCase of toolCases) {
    const { provider, calls } = createRecordingProvider();
    const tool = toolCase.createTool(provider);
    const args = tool.inputSchema.parse({ filepath: `fixture-${toolCase.mediaKind}` });

    await tool.callback(args, { signal: new AbortController().signal });

    assert.equal(calls.length, 1);
  }
});

test('each tool sends the correct RecognitionRequest fields', async () => {
  for (const toolCase of toolCases) {
    const { provider, calls } = createRecordingProvider();
    const tool = toolCase.createTool(provider);
    const args = tool.inputSchema.parse({
      filepath: `fixture-${toolCase.mediaKind}-path`,
      prompt: `${toolCase.mediaLabel} prompt`,
      modelname: `${toolCase.mediaLabel} model`
    });

    await tool.callback(args, { signal: new AbortController().signal });

    assert.deepEqual(calls[0]?.request, {
      filepath: `fixture-${toolCase.mediaKind}-path`,
      prompt: `${toolCase.mediaLabel} prompt`,
      mediaKind: toolCase.mediaKind,
      model: `${toolCase.mediaLabel} model`
    });
  }
});

test('each tool forwards the caller abort signal from extra', async () => {
  for (const toolCase of toolCases) {
    const { provider, calls } = createRecordingProvider();
    const tool = toolCase.createTool(provider);
    const args = tool.inputSchema.parse({ filepath: `fixture-${toolCase.mediaKind}` });
    const controller = new AbortController();

    await tool.callback(args, { signal: controller.signal });

    assert.equal(calls[0]?.options?.signal, controller.signal);
  }
});

test('successful recognition maps to the MCP success result shape', async () => {
  for (const toolCase of toolCases) {
    const { provider } = createRecordingProvider({
      result: { text: `${toolCase.mediaLabel} recognized` }
    });
    const tool = toolCase.createTool(provider);
    const args = tool.inputSchema.parse({ filepath: `fixture-${toolCase.mediaKind}` });

    const result = await tool.callback(args, { signal: new AbortController().signal });

    assert.deepEqual(result, {
      content: [{ type: 'text', text: `${toolCase.mediaLabel} recognized` }]
    });
  }
});

test('ProviderFailure maps to isError with the safe message', async () => {
  for (const toolCase of toolCases) {
    const { provider } = createRecordingProvider({
      failure: createProviderFailure({
        provider: 'gemini',
        category: 'rate-limit',
        safeMessage: `${toolCase.mediaLabel} safe failure message`,
        status: 429
      })
    });
    const tool = toolCase.createTool(provider);
    const args = tool.inputSchema.parse({ filepath: `fixture-${toolCase.mediaKind}` });

    const result = await tool.callback(args, { signal: new AbortController().signal });

    assert.deepEqual(result, {
      content: [{
        type: 'text',
        text: `Error processing ${toolCase.mediaLabel}: ${toolCase.mediaLabel} safe failure message`
      }],
      isError: true
    });
  }
});

test('non-ProviderFailure errors map to isError with generic error text', async () => {
  for (const toolCase of toolCases) {
    const { provider } = createRecordingProvider({
      failure: new Error(`${toolCase.mediaLabel} internal detail`)
    });
    const tool = toolCase.createTool(provider);
    const args = tool.inputSchema.parse({ filepath: `fixture-${toolCase.mediaKind}` });

    const result = await tool.callback(args, { signal: new AbortController().signal });

    assert.deepEqual(result, {
      content: [{
        type: 'text',
        text: `Error processing ${toolCase.mediaLabel}: ${toolCase.mediaLabel} internal detail`
      }],
      isError: true
    });
  }
});

test('failure cause is not exposed in the MCP result', async () => {
  for (const toolCase of toolCases) {
    const { provider } = createRecordingProvider({
      failure: createProviderFailure({
        provider: 'openai-compatible',
        category: 'authentication',
        safeMessage: 'credentials rejected',
        cause: new Error('secret api key detail')
      })
    });
    const tool = toolCase.createTool(provider);
    const args = tool.inputSchema.parse({ filepath: `fixture-${toolCase.mediaKind}` });

    const result = await tool.callback(args, { signal: new AbortController().signal });

    const serialized = JSON.stringify(result);
    assert.equal(serialized.includes('secret api key detail'), false);
    assert.equal(serialized.includes('cause'), false);
    assert.deepEqual(result, {
      content: [{
        type: 'text',
        text: `Error processing ${toolCase.mediaLabel}: credentials rejected`
      }],
      isError: true
    });
  }
});
