/**
 * status: active
 * phase: change-b-groups-4-5-recovery
 * sprint: gemini-model-fallback-and-rate-limit-recovery
 * last_modified: 2026-08-07
 * agent_notes: "Fake-provider tool tests plus startup source evidence for optional backup composition."
 * insights: "Tools remain unchanged; Gemini startup owns one shared cooldown store and constructs the configured backup only inside the explicit enabled branch."
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { createAudioRecognitionTool } from '../tools/audio-recognition.js';
import { createImageRecognitionTool } from '../tools/image-recognition.js';
import { createVideoRecognitionTool } from '../tools/video-recognition.js';
import { createProviderFailure } from '../services/provider-failure.js';
import { mapRecognitionToolFailure } from '../tools/recognition-tool-failure.js';
import { createRecoveryTerminalFailure } from '../services/recovery-diagnostics.js';
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

test('ProviderFailure maps to category-only MCP content without safeMessage', async () => {
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
        text: `Error processing ${toolCase.mediaLabel}: Recognition failed: provider=gemini; media=${toolCase.mediaKind}; category=rate-limit`
      }],
      isError: true
    });
  }
});

test('non-ProviderFailure errors map to fixed generic MCP content', async () => {
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
        text: `Error processing ${toolCase.mediaLabel}: Recognition failed: media=${toolCase.mediaKind}; category=unknown`
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
        text: `Error processing ${toolCase.mediaLabel}: Recognition failed: provider=openai-compatible; media=${toolCase.mediaKind}; category=authentication`
      }],
      isError: true
    });
  }
});

test('hostile safeMessage is sanitized only for operator output and absent from terminal output', () => {
  const hostile = 'api_key=HOSTILE_SAFE_MESSAGE_SENTINEL prompt="PRIVATE_PROMPT"';
  const mapped = mapRecognitionToolFailure(createProviderFailure({
    provider: 'openai-compatible', category: 'authentication', safeMessage: hostile,
    cause: new Error('RAW_CAUSE_SENTINEL')
  }), 'image');
  assert.equal(mapped.terminalMessage.includes('HOSTILE_SAFE_MESSAGE_SENTINEL'), false);
  assert.equal(mapped.terminalMessage.includes('PRIVATE_PROMPT'), false);
  assert.equal(mapped.operatorMessage.includes('HOSTILE_SAFE_MESSAGE_SENTINEL'), false);
  assert.equal(mapped.operatorMessage.includes('PRIVATE_PROMPT'), false);
  assert.equal(mapped.operatorMessage.includes('RAW_CAUSE_SENTINEL'), false);
  assert.equal(mapped.operatorMessage.includes('<redacted>'), true);
  assert.equal(Buffer.byteLength(mapped.operatorMessage, 'utf8') <= 4096, true);
});

test('trusted recovery terminal diagnostic crosses the tool boundary without safeMessage', () => {
  const failure = createRecoveryTerminalFailure({
    provider: 'gemini', category: 'temporary-service', mediaKind: 'audio',
    reason: 'deadline-terminated',
    attempts: [{ provider: 'gemini', model: 'model', attempt: 1, category: 'timeout' }]
  });
  const mapped = mapRecognitionToolFailure(failure, 'audio');
  assert.match(mapped.terminalMessage, /media=audio.*reason=deadline-terminated/u);
  assert.equal(mapped.terminalMessage.includes(failure.safeMessage), false);
});

test('Gemini startup composes one shared cooldown store and only the configured enabled backup', async () => {
  const source = await readFile(path.resolve(process.cwd(), 'src/index.ts'), 'utf8');
  assert.equal((source.match(/createProviderModelCooldownStore\(\)/gu) ?? []).length, 1);
  assert.match(source, /providerConfig\.recovery\.backup\.enabled/u);
  assert.match(source, /new OpenAICompatibleRecognitionProvider\(providerConfig\.recovery\.backup\.providerConfig\)/u);
  assert.match(source, /new GeminiRecognitionProvider\(service, providerConfig, \{/u);
  assert.match(source, /cooldowns,/u);
  assert.match(source, /backupProvider/u);
  assert.match(source, /diagnosticSink/u);
  assert.match(source, /formatRecoveryDiagnosticEvent/u);
  assert.match(source, /log\.info\(message\);/u);
  assert.match(source, /log\.warn\(message\);/u);
  assert.doesNotMatch(source, /GEMINI_BACKUP_MODEL|OPENROUTER_MODEL/u);
});
