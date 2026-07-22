/**
 * Tests for ParallelDispatcher prompt generation, aggregation, failure handling,
 * ordering, and internal llm_merge synthesis behavior.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ParallelDispatcher, sanitizeFailureReason } from '../services/parallel-dispatcher.js';
import type {
  ParallelInferenceConfig,
  ProviderCallOptions,
  RecognitionProvider,
  RecognitionRequest,
  RecognitionResult
} from '../types/index.js';

const baseRequest: RecognitionRequest = {
  filepath: 'sample.png',
  prompt: 'Describe the media.',
  mediaKind: 'image'
};

function makeConfig(overrides: Partial<ParallelInferenceConfig> = {}): ParallelInferenceConfig {
  return {
    enabled: true,
    dispatchMode: 'concurrent',
    promptCount: 3,
    aggregation: 'all_return',
    promptTemplates: [
      { name: 'CustomA', suffix: 'Focus on visible objects.' },
      { name: 'CustomB', suffix: 'Focus on temporal order.' },
      { name: 'CustomC', suffix: 'Focus on uncertainty.' }
    ],
    headerMergeTemplate: '## Summary\n\n## Key observations\n\nAgent {{agentIndex}}/{{agentCount}} {{templateName}}',
    llmMergePrompt: 'Configured synthesis prompt: deduplicate facts, preserve uncertainty, and do not invent details.',
    ...overrides
  };
}

function makeProvider(options: {
  recognize?: (request: RecognitionRequest, options?: ProviderCallOptions) => Promise<RecognitionResult>;
  synthesizeText?: (prompt: string, options?: ProviderCallOptions) => Promise<RecognitionResult>;
}): RecognitionProvider {
  return {
    info: {
      provider: 'gemini',
      providerLabel: 'Test Provider',
      modelName: 'test-model'
    },
    recognize: options.recognize ?? (async request => ({ text: `recognized: ${request.prompt}` })),
    synthesizeText: options.synthesizeText
  };
}

describe('ParallelDispatcher prompt generation', () => {
  it('generates deterministic variants and preserves the original prompt prefix', () => {
    const dispatcher = new ParallelDispatcher(makeConfig({ aggregation: 'all_return', promptCount: 3 }));

    const first = dispatcher.generateVariants(baseRequest.prompt, 3);
    const second = dispatcher.generateVariants(baseRequest.prompt, 3);

    assert.deepStrictEqual(first, second);
    assert.strictEqual(first.length, 3);
    assert.deepStrictEqual(first.map(v => v.templateName), ['Baseline', 'CustomA', 'CustomB']);
    assert.strictEqual(first[0].prompt, baseRequest.prompt);
    assert.ok(first[1].prompt.startsWith(baseRequest.prompt));
    assert.ok(first[1].prompt.includes('Focus on visible objects.'));
    assert.ok(first[2].prompt.startsWith(baseRequest.prompt));
    assert.ok(first[2].prompt.includes('Focus on temporal order.'));
  });

  it('retains prompt layout metadata while preserving flattened prompt text', () => {
    const dispatcher = new ParallelDispatcher(makeConfig({ aggregation: 'all_return', promptCount: 3 }));
    const variants = dispatcher.generateVariants(baseRequest.prompt, 3);

    assert.deepStrictEqual(variants[0].promptLayout, {
      stableTextPrefix: baseRequest.prompt,
      variableTextSuffix: ''
    });
    assert.strictEqual(variants[0].prompt, baseRequest.prompt);

    assert.strictEqual(variants[1].promptLayout.stableTextPrefix, baseRequest.prompt);
    assert.strictEqual(variants[1].promptLayout.variableTextSuffix, 'Focus on visible objects.');
    assert.strictEqual(variants[1].promptLayout.variableTextSuffix.includes(baseRequest.prompt), false);
    assert.strictEqual(variants[1].prompt, `${baseRequest.prompt}\n\n${variants[1].promptLayout.variableTextSuffix}`);

    assert.strictEqual(variants[2].promptLayout.stableTextPrefix, baseRequest.prompt);
    assert.strictEqual(variants[2].promptLayout.variableTextSuffix, 'Focus on temporal order.');
    assert.strictEqual(variants[2].prompt, `${baseRequest.prompt}\n\n${variants[2].promptLayout.variableTextSuffix}`);
  });

  it('appends resolved per-variant header_merge fill instructions after prompt and suffix', () => {
    const dispatcher = new ParallelDispatcher(makeConfig({ aggregation: 'header_merge', promptCount: 2 }));
    const variants = dispatcher.generateVariants(baseRequest.prompt, 2);
    const baselineSuffix = variants[0].promptLayout.variableTextSuffix ?? '';
    const variantSuffix = variants[1].promptLayout.variableTextSuffix ?? '';

    assert.ok(variants[0].prompt.startsWith(baseRequest.prompt));
    assert.ok(variants[0].prompt.includes('You are Ensemble Agent 1 of 2 (Baseline).'));
    assert.ok(variants[0].prompt.includes('Agent 1/2 Baseline'));
    assert.strictEqual(variants[0].prompt.indexOf(baseRequest.prompt), 0);
    assert.strictEqual(variants[0].promptLayout.stableTextPrefix, baseRequest.prompt);
    assert.strictEqual(baselineSuffix.includes(baseRequest.prompt), false);
    assert.ok(baselineSuffix.startsWith('You are Ensemble Agent 1 of 2 (Baseline).'));
    assert.strictEqual(variants[0].prompt, `${baseRequest.prompt}\n\n${baselineSuffix}`);

    assert.ok(variants[1].prompt.startsWith(baseRequest.prompt));
    assert.ok(variants[1].prompt.indexOf('Focus on visible objects.') > baseRequest.prompt.length);
    assert.ok(variants[1].prompt.indexOf('You are Ensemble Agent 2 of 2 (CustomA).') > variants[1].prompt.indexOf('Focus on visible objects.'));
    assert.ok(variants[1].prompt.includes('Agent 2/2 CustomA'));
    assert.strictEqual(variants[1].promptLayout.stableTextPrefix, baseRequest.prompt);
    assert.strictEqual(variantSuffix.includes(baseRequest.prompt), false);
    assert.ok(variantSuffix.startsWith('Focus on visible objects.'));
    assert.ok(variantSuffix.includes('You are Ensemble Agent 2 of 2 (CustomA).'));
    assert.strictEqual(variants[1].prompt, `${baseRequest.prompt}\n\n${variantSuffix}`);
  });
});

describe('ParallelDispatcher dispatch and aggregation', () => {
  it('short-circuits to direct recognize when disabled', async () => {
    let calls = 0;
    const provider = makeProvider({
      recognize: async (request, options) => {
        calls++;
        assert.strictEqual(options, undefined);
        assert.strictEqual(request.prompt, baseRequest.prompt);
        return { text: 'direct result' };
      },
      synthesizeText: async () => {
        throw new Error('should not synthesize');
      }
    });
    const dispatcher = new ParallelDispatcher(makeConfig({ enabled: false, promptCount: 3, aggregation: 'llm_merge' }));

    const result = await dispatcher.dispatch(baseRequest, provider);

    assert.strictEqual(calls, 1);
    assert.strictEqual(result.aggregatedText, 'direct result');
    assert.strictEqual(result.succeededCount, 1);
    assert.strictEqual(result.failedCount, 0);
    assert.strictEqual(result.isError, false);
  });

  it('short-circuits to direct recognize when prompt count is one', async () => {
    let calls = 0;
    const provider = makeProvider({
      recognize: async (request, options) => {
        calls++;
        assert.strictEqual(options, undefined);
        assert.strictEqual(request.prompt, baseRequest.prompt);
        return { text: 'single result' };
      }
    });
    const dispatcher = new ParallelDispatcher(makeConfig({ enabled: true, promptCount: 1 }));

    const result = await dispatcher.dispatch(baseRequest, provider);

    assert.strictEqual(calls, 1);
    assert.strictEqual(result.aggregatedText, 'single result');
    assert.strictEqual(result.succeededCount, 1);
    assert.strictEqual(result.failedCount, 0);
  });

  it('passes one shared session id and stable instruction to sibling recognition calls', async () => {
    const calls: { request: RecognitionRequest; options?: ProviderCallOptions }[] = [];
    const provider = makeProvider({
      recognize: async (request, options) => {
        calls.push({ request, options });
        return { text: `recognized ${calls.length}` };
      }
    });
    const dispatcher = new ParallelDispatcher(makeConfig({ aggregation: 'all_return', promptCount: 3 }));

    await dispatcher.dispatch(baseRequest, provider);

    assert.strictEqual(calls.length, 3);
    const sessionId = calls[0].options?.sessionId ?? '';
    assert.match(sessionId, /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    for (const call of calls) {
      assert.strictEqual(call.options?.sessionId, sessionId);
      assert.strictEqual(call.options?.stableInstruction, calls[0].options?.stableInstruction);
      assert.deepStrictEqual(call.options?.promptLayout?.stableTextPrefix, baseRequest.prompt);
    }

    const stableInstruction = calls[0].options?.stableInstruction;
    assert.strictEqual(stableInstruction?.role, 'system');
    assert.ok(stableInstruction?.text.includes('media recognition assistant'));
    assert.ok(stableInstruction?.text.includes('observable evidence'));
    assert.ok(stableInstruction?.text.includes('preserve uncertainty'));
    assert.ok(stableInstruction?.text.includes('avoid invented details'));
    assert.strictEqual(stableInstruction?.text.includes(baseRequest.prompt), false);
    assert.strictEqual(stableInstruction?.text.includes(baseRequest.filepath), false);
    assert.strictEqual(stableInstruction?.text.includes('Focus on visible objects.'), false);
    assert.strictEqual(stableInstruction?.text.includes('Focus on temporal order.'), false);
    assert.strictEqual(stableInstruction?.text.includes('all_return'), false);
    assert.strictEqual(stableInstruction?.text.includes('CustomA'), false);
  });

  it('aggregates all_return successful raw blocks in variant order', async () => {
    const provider = makeProvider({
      recognize: async request => ({ text: `RAW(${request.prompt})` })
    });
    const dispatcher = new ParallelDispatcher(makeConfig({ aggregation: 'all_return', promptCount: 3 }));

    const result = await dispatcher.dispatch(baseRequest, provider);

    assert.strictEqual(result.succeededCount, 3);
    assert.strictEqual(result.failedCount, 0);
    assert.ok(result.aggregatedText.startsWith('## Ensemble Agent 1 of 3 (Baseline)\n\nRAW(Describe the media.)'));
    assert.ok(result.aggregatedText.includes('\n\n---\n\n## Ensemble Agent 2 of 3 (CustomA)'));
    assert.ok(result.aggregatedText.includes('\n\n---\n\n## Ensemble Agent 3 of 3 (CustomB)'));
    assert.ok(result.aggregatedText.includes('Focus on visible objects.'));
    assert.strictEqual(result.aggregatedText.includes('Parallel inference metadata'), false);
  });

  it('keeps aggregation ordering independent of completion order', async () => {
    const provider = makeProvider({
      recognize: async request => {
        const prompt = request.prompt;
        if (prompt.includes('Focus on visible objects.')) {
          await delay(30);
          return { text: 'second completed last' };
        }
        if (prompt.includes('Focus on temporal order.')) {
          return { text: 'third completed first' };
        }
        await delay(10);
        return { text: 'first completed middle' };
      }
    });
    const dispatcher = new ParallelDispatcher(makeConfig({ aggregation: 'all_return', promptCount: 3 }));

    const result = await dispatcher.dispatch(baseRequest, provider);

    assert.ok(result.aggregatedText.indexOf('Agent 1 of 3') < result.aggregatedText.indexOf('Agent 2 of 3'));
    assert.ok(result.aggregatedText.indexOf('Agent 2 of 3') < result.aggregatedText.indexOf('Agent 3 of 3'));
    assert.ok(result.aggregatedText.indexOf('first completed middle') < result.aggregatedText.indexOf('second completed last'));
    assert.ok(result.aggregatedText.indexOf('second completed last') < result.aggregatedText.indexOf('third completed first'));
  });

  it('dispatches variants concurrently through the same provider instance', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    let calls = 0;
    const provider = makeProvider({
      recognize: async () => {
        calls++;
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await delay(20);
        inFlight--;
        return { text: `call ${calls}` };
      }
    });
    const dispatcher = new ParallelDispatcher(makeConfig({ aggregation: 'all_return', promptCount: 3 }));

    await dispatcher.dispatch(baseRequest, provider);

    assert.strictEqual(calls, 3);
    assert.ok(maxInFlight > 1, `expected concurrent calls, max in-flight was ${maxInFlight}`);
  });

  it('concatenates header_merge filled docs with metadata and does not synthesize', async () => {
    const prompts: string[] = [];
    let synthesizeCalls = 0;
    const provider = makeProvider({
      recognize: async request => {
        prompts.push(request.prompt);
        return { text: `filled document ${prompts.length}` };
      },
      synthesizeText: async () => {
        synthesizeCalls++;
        return { text: 'unexpected synthesis' };
      }
    });
    const dispatcher = new ParallelDispatcher(makeConfig({ aggregation: 'header_merge', promptCount: 2 }));

    const result = await dispatcher.dispatch(baseRequest, provider);

    assert.strictEqual(synthesizeCalls, 0);
    assert.strictEqual(prompts.length, 2);
    assert.ok(prompts[0].includes('You are Ensemble Agent 1 of 2 (Baseline).'));
    assert.ok(prompts[1].includes('You are Ensemble Agent 2 of 2 (CustomA).'));
    assert.ok(result.aggregatedText.includes('## Ensemble Agent 1 of 2 (Baseline)\n\nfilled document 1'));
    assert.ok(result.aggregatedText.includes('## Ensemble Agent 2 of 2 (CustomA)\n\nfilled document 2'));
    assert.ok(result.aggregatedText.trim().endsWith('_Parallel inference metadata: dispatched=2; succeeded=2; failed=0; aggregation=header_merge._'));
  });

  it('uses llm_merge synthesis prompt and returns synthesized text with metadata', async () => {
    let synthesisPrompt = '';
    const recognitionOptions: ProviderCallOptions[] = [];
    let synthesisOptions: ProviderCallOptions | undefined;
    const provider = makeProvider({
      recognize: async (request, options) => {
        if (options) {
          recognitionOptions.push(options);
        }
        return { text: request.prompt.includes('Focus on visible objects.') ? 'agent two facts' : 'agent one facts' };
      },
      synthesizeText: async (prompt, options) => {
        synthesisPrompt = prompt;
        synthesisOptions = options;
        return { text: 'synthesized markdown' };
      }
    });
    const dispatcher = new ParallelDispatcher(makeConfig({ aggregation: 'llm_merge', promptCount: 2 }));

    const result = await dispatcher.dispatch(baseRequest, provider);

    assert.ok(synthesisPrompt.startsWith('Configured synthesis prompt'));
    assert.ok(synthesisPrompt.includes('<ensemble-response index="1" total="2" template="Baseline">'));
    assert.ok(synthesisPrompt.includes('<ensemble-response index="2" total="2" template="CustomA">'));
    assert.ok(synthesisPrompt.includes('agent one facts'));
    assert.ok(synthesisPrompt.includes('agent two facts'));
    assert.ok(synthesisPrompt.includes('Deduplicate repeated facts'));
    assert.ok(synthesisPrompt.includes('do not add unsupported facts'));
    const sessionId = recognitionOptions[0].sessionId;
    assert.ok(sessionId);
    assert.strictEqual(recognitionOptions.every(option => option.sessionId === sessionId), true);
    assert.strictEqual(synthesisOptions?.sessionId, sessionId);
    assert.strictEqual(result.aggregatedText, 'synthesized markdown\n\n---\n\n_Parallel inference metadata: dispatched=2; succeeded=2; failed=0; aggregation=llm_merge._');
  });

  it('falls back deterministically when llm_merge synthesis capability is missing', async () => {
    const provider = makeProvider({
      recognize: async request => ({ text: request.prompt.includes('Focus on visible objects.') ? 'variant two' : 'variant one' })
    });
    delete provider.synthesizeText;
    const dispatcher = new ParallelDispatcher(makeConfig({ aggregation: 'llm_merge', promptCount: 2 }));

    const result = await dispatcher.dispatch(baseRequest, provider);

    assert.ok(result.aggregatedText.includes('## Ensemble Agent 1 of 2 (Baseline)\n\nvariant one'));
    assert.ok(result.aggregatedText.includes('## Ensemble Agent 2 of 2 (CustomA)\n\nvariant two'));
    assert.ok(result.aggregatedText.includes('Synthesis note: llm_merge synthesis unavailable'));
    assert.ok(result.aggregatedText.includes('aggregation=llm_merge'));
  });

  it('falls back deterministically when llm_merge synthesis returns an error', async () => {
    const provider = makeProvider({
      recognize: async () => ({ text: 'successful variant text' }),
      synthesizeText: async () => ({ text: 'Authorization: Bearer SECRET_TOKEN_SHOULD_NOT_LEAK', isError: true })
    });
    const dispatcher = new ParallelDispatcher(makeConfig({ aggregation: 'llm_merge', promptCount: 2 }));

    const result = await dispatcher.dispatch(baseRequest, provider);

    assert.ok(result.aggregatedText.includes('successful variant text'));
    assert.ok(result.aggregatedText.includes('Synthesis note: llm_merge synthesis failed'));
    assert.ok(result.aggregatedText.includes('Bearer [redacted]'));
    assert.strictEqual(result.aggregatedText.includes('SECRET_TOKEN_SHOULD_NOT_LEAK'), false);
  });

  it('returns partial success with sanitized failure metadata', async () => {
    const longSecret = 'A'.repeat(120);
    const provider = makeProvider({
      recognize: async request => {
        if (request.prompt.includes('Focus on visible objects.')) {
          return { text: `failed with api_key=SECRET123 and data:image/png;base64,${longSecret}`, isError: true };
        }
        return { text: 'usable result' };
      }
    });
    const dispatcher = new ParallelDispatcher(makeConfig({ aggregation: 'all_return', promptCount: 2 }));

    const result = await dispatcher.dispatch(baseRequest, provider);

    assert.strictEqual(result.isError, false);
    assert.strictEqual(result.succeededCount, 1);
    assert.strictEqual(result.failedCount, 1);
    assert.ok(result.aggregatedText.includes('usable result'));
    assert.ok(result.aggregatedText.includes('api_key=[redacted]'));
    assert.ok(result.aggregatedText.includes('data:[redacted]'));
    assert.strictEqual(result.aggregatedText.includes('SECRET123'), false);
    assert.strictEqual(result.aggregatedText.includes(longSecret), false);
  });

  it('returns an error result when all variants fail or reject', async () => {
    const provider = makeProvider({
      recognize: async request => {
        if (request.prompt.includes('Focus on visible objects.')) {
          throw new Error('Bearer abcdefghijklmnopqrstuvwxyz0123456789');
        }
        return { text: 'token=super-secret-token', isError: true };
      }
    });
    const dispatcher = new ParallelDispatcher(makeConfig({ aggregation: 'all_return', promptCount: 2 }));

    const result = await dispatcher.dispatch(baseRequest, provider);

    assert.strictEqual(result.isError, true);
    assert.strictEqual(result.succeededCount, 0);
    assert.strictEqual(result.failedCount, 2);
    assert.ok(result.aggregatedText.startsWith('Parallel inference failed for all 2 variant(s).'));
    assert.ok(result.aggregatedText.includes('token=[redacted]'));
    assert.ok(result.aggregatedText.includes('Bearer [redacted]'));
    assert.strictEqual(result.aggregatedText.includes('super-secret-token'), false);
    assert.strictEqual(result.aggregatedText.includes('abcdefghijklmnopqrstuvwxyz0123456789'), false);
  });
});

describe('sanitizeFailureReason', () => {
  it('redacts common secrets, data URLs, long payloads, and compacts whitespace', () => {
    const reason = sanitizeFailureReason(
      'bad\nAuthorization: Bearer shhhhhhhhhhhhhhhhhhhhhhhhh data:image/png;base64,' + 'B'.repeat(120) + ' password=hunter2'
    );

    assert.ok(reason.includes('Bearer [redacted]'));
    assert.ok(reason.includes('data:[redacted]'));
    assert.ok(reason.includes('password=[redacted]'));
    assert.strictEqual(reason.includes('hunter2'), false);
    assert.strictEqual(reason.includes('\n'), false);
    assert.ok(reason.length <= 240);
  });
});

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}