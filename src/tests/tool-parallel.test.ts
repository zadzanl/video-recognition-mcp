/**
 * Integration-level tests for recognition tool factories and parallel dispatch wiring.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createImageRecognitionTool } from '../tools/image-recognition.js';
import { createAudioRecognitionTool } from '../tools/audio-recognition.js';
import { createVideoRecognitionTool } from '../tools/video-recognition.js';
import type { ParallelDispatchResult, ParallelInferenceConfig, RecognitionProvider, RecognitionRequest, RecognitionResult } from '../types/index.js';

const parallelSentence = 'This tool dispatches 3 parallel prompt variants per call for improved recognition quality (aggregation: header_merge).';
const expectedAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  openWorldHint: true
} as const;

type RecognitionToolDefinition =
  | ReturnType<typeof createImageRecognitionTool>
  | ReturnType<typeof createAudioRecognitionTool>
  | ReturnType<typeof createVideoRecognitionTool>;

interface ToolCase {
  label: string;
  mediaKind: RecognitionRequest['mediaKind'];
  defaultPrompt: string;
  expectedTitle: string;
  expectedBaseDescription: string;
  createTool: (provider: RecognitionProvider, config?: ParallelInferenceConfig, dispatcher?: FakeDispatcher) => RecognitionToolDefinition;
}

interface FakeDispatcher {
  dispatch(request: RecognitionRequest, provider: RecognitionProvider): Promise<ParallelDispatchResult>;
}

const toolCases: ToolCase[] = [
  {
    label: 'image',
    mediaKind: 'image',
    defaultPrompt: 'Describe this image',
    expectedTitle: 'Image recognition',
    expectedBaseDescription: 'Analyze and describe images from a local file path using test-model via Test Provider. Configure provider credentials in the environment before starting the server. Media can be uploaded or encoded and sent to the external provider endpoint, so latency and provider rate limits can apply. The tool returns plain text, and failures are returned as tool errors. Supported image formats depend on the active provider and model, with common support for JPG, JPEG, PNG, and WEBP.',
    createTool: createImageRecognitionTool
  },
  {
    label: 'audio',
    mediaKind: 'audio',
    defaultPrompt: 'Describe this audio',
    expectedTitle: 'Audio recognition',
    expectedBaseDescription: 'Analyze and transcribe audio from a local file path using test-model via Test Provider. Configure provider credentials in the environment before starting the server. Media can be uploaded or encoded and sent to the external provider endpoint, so latency and provider rate limits can apply. The tool returns plain text, and failures are returned as tool errors. Supported audio formats depend on the active provider and model, with common support for WAV, MP3, and OGG.',
    createTool: createAudioRecognitionTool
  },
  {
    label: 'video',
    mediaKind: 'video',
    defaultPrompt: 'Describe this video',
    expectedTitle: 'Video recognition',
    expectedBaseDescription: 'Analyze and describe videos from a local file path using test-model via Test Provider. Configure provider credentials in the environment before starting the server. Media can be uploaded or encoded and sent to the external provider endpoint, so latency and provider rate limits can apply. The tool returns plain text, and failures are returned as tool errors. Supported video formats depend on the active provider and model, with common support for MP4, MOV, WEBM, AVI, and MPEG.',
    createTool: createVideoRecognitionTool
  }
];

describe('recognition tool parallel integration', () => {
  for (const toolCase of toolCases) {
    it(`${toolCase.label} disabled mode calls provider directly and keeps schema and description unchanged`, async () => {
      let providerCalls = 0;
      let dispatcherCalls = 0;
      const provider = makeProvider(async request => {
        providerCalls++;
        assert.deepStrictEqual(request, {
          filepath: `${toolCase.label}.fixture`,
          prompt: 'Describe this fixture',
          mediaKind: toolCase.mediaKind
        });
        return { text: `${toolCase.label} direct result` };
      });
      const dispatcher: FakeDispatcher = {
        dispatch: async () => {
          dispatcherCalls++;
          throw new Error('disabled tools should not dispatch');
        }
      };

      const tool = toolCase.createTool(provider, makeConfig({ enabled: false, promptCount: 3 }), dispatcher);
      const result = await tool.callback({ filepath: `${toolCase.label}.fixture`, prompt: 'Describe this fixture' });

      assert.strictEqual(tool.title, toolCase.expectedTitle);
      assert.strictEqual(tool.description, toolCase.expectedBaseDescription);
      assert.strictEqual(tool.description.includes('parallel prompt variants'), false);
      assert.deepStrictEqual(tool.annotations, expectedAnnotations);
      assert.deepStrictEqual(Object.keys(tool.inputSchema.shape).sort(), ['filepath', 'prompt']);
      assert.strictEqual(providerCalls, 1);
      assert.strictEqual(dispatcherCalls, 0);
      assert.deepStrictEqual(result.content, [{ type: 'text', text: `${toolCase.label} direct result` }]);
      assert.strictEqual(result.isError, undefined);
    });

    it(`${toolCase.label} prompt count one calls provider directly and keeps description unchanged`, async () => {
      let providerCalls = 0;
      let dispatcherCalls = 0;
      const provider = makeProvider(async request => {
        providerCalls++;
        assert.strictEqual(request.prompt, toolCase.defaultPrompt);
        assert.strictEqual(request.mediaKind, toolCase.mediaKind);
        return { text: `${toolCase.label} single prompt result` };
      });
      const dispatcher: FakeDispatcher = {
        dispatch: async () => {
          dispatcherCalls++;
          throw new Error('single-prompt tools should not dispatch');
        }
      };

      const tool = toolCase.createTool(provider, makeConfig({ enabled: true, promptCount: 1 }), dispatcher);
      const result = await tool.callback({ filepath: `${toolCase.label}.fixture` });

      assert.strictEqual(tool.title, toolCase.expectedTitle);
      assert.strictEqual(tool.description, toolCase.expectedBaseDescription);
      assert.deepStrictEqual(tool.annotations, expectedAnnotations);
      assert.strictEqual(providerCalls, 1);
      assert.strictEqual(dispatcherCalls, 0);
      assert.deepStrictEqual(result.content, [{ type: 'text', text: `${toolCase.label} single prompt result` }]);
      assert.strictEqual(result.isError, undefined);
    });

    it(`${toolCase.label} enabled mode dispatches and returns aggregated text`, async () => {
      let providerCalls = 0;
      let dispatcherCalls = 0;
      const provider = makeProvider(async () => {
        providerCalls++;
        throw new Error('enabled tools should dispatch instead of calling provider directly');
      });
      const dispatcher: FakeDispatcher = {
        dispatch: async (request, dispatchedProvider) => {
          dispatcherCalls++;
          assert.strictEqual(dispatchedProvider, provider);
          assert.deepStrictEqual(request, {
            filepath: `${toolCase.label}.fixture`,
            prompt: 'Prompt for aggregation',
            mediaKind: toolCase.mediaKind
          });
          return makeDispatchResult({ aggregatedText: `${toolCase.label} aggregated result` });
        }
      };

      const tool = toolCase.createTool(provider, makeConfig(), dispatcher);
      const result = await tool.callback({ filepath: `${toolCase.label}.fixture`, prompt: 'Prompt for aggregation' });

      assert.strictEqual(tool.title, toolCase.expectedTitle);
      assert.deepStrictEqual(tool.annotations, expectedAnnotations);
      assert.strictEqual(providerCalls, 0);
      assert.strictEqual(dispatcherCalls, 1);
      assert.deepStrictEqual(result.content, [{ type: 'text', text: `${toolCase.label} aggregated result` }]);
      assert.strictEqual(result.isError, undefined);
    });

    it(`${toolCase.label} dispatcher isError maps to tool error`, async () => {
      const provider = makeProvider();
      const dispatcher: FakeDispatcher = {
        dispatch: async () => makeDispatchResult({ aggregatedText: `${toolCase.label} aggregate failure`, isError: true })
      };

      const tool = toolCase.createTool(provider, makeConfig(), dispatcher);
      const result = await tool.callback({ filepath: `${toolCase.label}.fixture`, prompt: 'Prompt' });

      assert.strictEqual(tool.title, toolCase.expectedTitle);
      assert.deepStrictEqual(tool.annotations, expectedAnnotations);
      assert.deepStrictEqual(result.content, [{ type: 'text', text: `${toolCase.label} aggregate failure` }]);
      assert.strictEqual(result.isError, true);
    });

    it(`${toolCase.label} partial dispatcher success is not marked as a tool error`, async () => {
      const provider = makeProvider();
      const dispatcher: FakeDispatcher = {
        dispatch: async () => makeDispatchResult({
          aggregatedText: `${toolCase.label} partial aggregate`,
          succeededCount: 2,
          failedCount: 1,
          isError: false
        })
      };

      const tool = toolCase.createTool(provider, makeConfig(), dispatcher);
      const result = await tool.callback({ filepath: `${toolCase.label}.fixture`, prompt: 'Prompt' });

      assert.strictEqual(tool.title, toolCase.expectedTitle);
      assert.deepStrictEqual(tool.annotations, expectedAnnotations);
      assert.deepStrictEqual(result.content, [{ type: 'text', text: `${toolCase.label} partial aggregate` }]);
      assert.strictEqual(result.isError, undefined);
    });

    it(`${toolCase.label} enabled description includes one parallel summary sentence and unchanged schema`, () => {
      const provider = makeProvider();
      const tool = toolCase.createTool(provider, makeConfig());

      assert.strictEqual(tool.title, toolCase.expectedTitle);
      assert.strictEqual(tool.description, `${toolCase.expectedBaseDescription} ${parallelSentence}`);
      assert.strictEqual(countOccurrences(tool.description, parallelSentence), 1);
      assert.deepStrictEqual(tool.annotations, expectedAnnotations);
      assert.deepStrictEqual(Object.keys(tool.inputSchema.shape).sort(), ['filepath', 'prompt']);
    });
  }
});

function makeConfig(overrides: Partial<ParallelInferenceConfig> = {}): ParallelInferenceConfig {
  return {
    enabled: true,
    promptCount: 3,
    aggregation: 'header_merge',
    promptTemplates: [
      { name: 'VariantA', suffix: 'Focus on visible details.' },
      { name: 'VariantB', suffix: 'Focus on temporal details.' },
      { name: 'VariantC', suffix: 'Focus on uncertainty.' }
    ],
    headerMergeTemplate: '## Summary',
    llmMergePrompt: 'Merge the variants.',
    ...overrides
  };
}

function makeProvider(recognize?: (request: RecognitionRequest) => Promise<RecognitionResult>): RecognitionProvider {
  return {
    info: {
      provider: 'gemini',
      providerLabel: 'Test Provider',
      modelName: 'test-model'
    },
    recognize: recognize ?? (async () => ({ text: 'provider result' }))
  };
}

function makeDispatchResult(overrides: Partial<ParallelDispatchResult> = {}): ParallelDispatchResult {
  return {
    aggregatedText: 'aggregated result',
    variants: [],
    dispatchedCount: 3,
    succeededCount: 3,
    failedCount: 0,
    aggregation: 'header_merge',
    isError: false,
    ...overrides
  };
}

function countOccurrences(value: string, needle: string): number {
  return value.split(needle).length - 1;
}