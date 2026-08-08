/**
 * status: active
 * phase: phase-5-tool-server-wiring
 * sprint: provider-foundation-first-sprint
 * last_modified: 2026-08-06
 * agent_notes: "Characterizes tool contracts against a fake RecognitionProvider after Phase 5 rewiring."
 * insights: "Schema supplies the prompt default; omitted model reaches the provider as request.model undefined. Providers signal failures by throwing, so service-error envelopes now come from thrown ProviderFailure values."
 */

import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAudioRecognitionTool } from '../tools/audio-recognition.js';
import { createImageRecognitionTool } from '../tools/image-recognition.js';
import { createVideoRecognitionTool } from '../tools/video-recognition.js';
import { createProviderFailure } from '../services/provider-failure.js';
import type {
  RecognitionProvider,
  RecognitionRequest,
  RecognitionResult
} from '../types/provider.js';

const temporaryDirectory = await mkdtemp(join(tmpdir(), 'media-processing-baseline-'));

after(async () => {
  await rm(temporaryDirectory, { recursive: true, force: true });
});

interface FakeCalls {
  requests: RecognitionRequest[];
}

interface FakeBehavior {
  result?: RecognitionResult;
  failure?: Error;
}

const createFakeProvider = (behavior: FakeBehavior = {}): {
  provider: RecognitionProvider;
  calls: FakeCalls;
} => {
  const calls: FakeCalls = {
    requests: []
  };

  const provider: RecognitionProvider = {
    recognize: async (request: RecognitionRequest): Promise<RecognitionResult> => {
      calls.requests.push(request);
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
    mediaKind: 'image',
    extension: '.png',
    createTool: createImageRecognitionTool
  },
  {
    name: 'audio_recognition',
    mediaLabel: 'audio',
    mediaKind: 'audio',
    extension: '.wav',
    createTool: createAudioRecognitionTool
  },
  {
    name: 'video_recognition',
    mediaLabel: 'video',
    mediaKind: 'video',
    extension: '.mp4',
    createTool: createVideoRecognitionTool
  }
] as const;

test('recognition tools retain exact names and input keys', () => {
  for (const toolCase of toolCases) {
    const { provider } = createFakeProvider();
    const tool = toolCase.createTool(provider);

    assert.equal(tool.name, toolCase.name);
    assert.deepEqual(
      Object.keys(tool.inputSchema.shape).sort(),
      ['filepath', 'modelname', 'prompt']
    );
  }
});

test('schemas default an omitted prompt to exactly Describe this content', () => {
  for (const toolCase of toolCases) {
    const { provider } = createFakeProvider();
    const tool = toolCase.createTool(provider);
    const parsed = tool.inputSchema.parse({ filepath: `fixture${toolCase.extension}` });

    assert.equal(parsed.prompt, 'Describe this content');
    assert.equal(parsed.modelname, undefined);
  }
});

test('tools forward schema prompt default and omitted model without local fallbacks', async () => {
  for (const [index, toolCase] of toolCases.entries()) {
    const filepath = join(temporaryDirectory, `omitted-values-${index}${toolCase.extension}`);
    await writeFile(filepath, 'fixture');
    const { provider, calls } = createFakeProvider();
    const tool = toolCase.createTool(provider);
    const args = tool.inputSchema.parse({ filepath });

    await tool.callback(args, { signal: new AbortController().signal });

    assert.equal(calls.requests.length, 1);
    assert.equal(calls.requests[0]?.prompt, 'Describe this content');
    assert.equal(calls.requests[0]?.model, undefined);
  }
});

test('tools forward args.modelname directly, explicit verbatim and omitted as undefined', async () => {
  for (const [index, toolCase] of toolCases.entries()) {
    const explicitPath = join(temporaryDirectory, `modelname-explicit-${index}${toolCase.extension}`);
    const omittedPath = join(temporaryDirectory, `modelname-omitted-${index}${toolCase.extension}`);
    await writeFile(explicitPath, 'fixture');
    await writeFile(omittedPath, 'fixture');
    const { provider, calls } = createFakeProvider();
    const tool = toolCase.createTool(provider);

    await tool.callback(
      tool.inputSchema.parse({ filepath: explicitPath, modelname: 'Client-Override-Model' }),
      { signal: new AbortController().signal }
    );
    await tool.callback(
      tool.inputSchema.parse({ filepath: omittedPath }),
      { signal: new AbortController().signal }
    );

    assert.equal(calls.requests.length, 2);
    assert.equal(calls.requests[0]?.model, 'Client-Override-Model');
    assert.equal(calls.requests[1]?.model, undefined);
  }
});

test('tools forward explicit prompt and model and retain success envelopes', async () => {
  for (const [index, toolCase] of toolCases.entries()) {
    const filepath = join(temporaryDirectory, `success-${index}${toolCase.extension}`);
    await writeFile(filepath, 'fixture');
    const { provider, calls } = createFakeProvider({
      result: { text: `${toolCase.mediaLabel} success` }
    });
    const tool = toolCase.createTool(provider);
    const args = tool.inputSchema.parse({
      filepath,
      prompt: `${toolCase.mediaLabel} prompt`,
      modelname: `${toolCase.mediaLabel} model`
    });

    const result = await tool.callback(args, { signal: new AbortController().signal });

    assert.equal(calls.requests.length, 1);
    assert.deepEqual(calls.requests[0], {
      filepath,
      prompt: `${toolCase.mediaLabel} prompt`,
      mediaKind: toolCase.mediaKind,
      model: `${toolCase.mediaLabel} model`
    });
    assert.deepEqual(result, {
      content: [{ type: 'text', text: `${toolCase.mediaLabel} success` }]
    });
  }
});

test('tools map thrown provider failures to category-only isError envelopes', async () => {
  for (const [index, toolCase] of toolCases.entries()) {
    const filepath = join(temporaryDirectory, `provider-failure-${index}${toolCase.extension}`);
    await writeFile(filepath, 'fixture');
    const { provider } = createFakeProvider({
      failure: createProviderFailure({
        provider: 'gemini',
        category: 'temporary-service',
        safeMessage: `${toolCase.mediaLabel} provider failure`
      })
    });
    const tool = toolCase.createTool(provider);
    const args = tool.inputSchema.parse({ filepath });

    const result = await tool.callback(args, { signal: new AbortController().signal });

    assert.deepEqual(result, {
      content: [{
        type: 'text',
        text: `Error processing ${toolCase.mediaLabel}: Recognition failed: provider=gemini; media=${toolCase.mediaKind}; category=temporary-service`
      }],
      isError: true
    });
  }
});

test('tools retain generic thrown-error MCP envelopes without raw messages', async () => {
  for (const [index, toolCase] of toolCases.entries()) {
    const filepath = join(temporaryDirectory, `thrown-error-${index}${toolCase.extension}`);
    await writeFile(filepath, 'fixture');
    const { provider } = createFakeProvider({
      failure: new Error(`${toolCase.mediaLabel} upload failed`)
    });
    const tool = toolCase.createTool(provider);
    const args = tool.inputSchema.parse({ filepath });

    const result = await tool.callback(args, { signal: new AbortController().signal });

    assert.deepEqual(result, {
      content: [{
        type: 'text',
        text: `Error processing ${toolCase.mediaLabel}: Recognition failed: media=${toolCase.mediaKind}; category=unknown`
      }],
      isError: true
    });
  }
});