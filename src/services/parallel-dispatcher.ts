/**
 * Parallel ensemble inference dispatcher.
 *
 * This service stays internal to preserve MCP tool schemas while tool callbacks
 * decide whether to route requests through parallel dispatch.
 */

import { BUILT_IN_PROMPT_TEMPLATES } from './provider-config.js';
import type {
  ParallelDispatchResult,
  ParallelInferenceConfig,
  ParallelPromptVariant,
  ParallelVariantResult,
  PromptTemplate,
  RecognitionProvider,
  RecognitionRequest,
  RecognitionResult
} from '../types/index.js';

const HEADER_SEPARATOR = '\n\n---\n\n';
const FAILURE_REASON_MAX_LENGTH = 240;

interface SuccessfulVariant extends ParallelVariantResult {
  status: 'success';
  result: RecognitionResult;
}

export class ParallelDispatcher {
  constructor(private readonly config: ParallelInferenceConfig) {}

  generateVariants(basePrompt: string, count: number): ParallelPromptVariant[] {
    const safeCount = Math.max(0, Math.floor(count));
    const suffixTemplates = this.resolveSuffixTemplates(Math.max(safeCount - 1, 0));
    const variants: ParallelPromptVariant[] = [];

    for (let i = 0; i < safeCount; i++) {
      const index = i + 1;
      const suffixTemplate = i === 0 ? undefined : suffixTemplates[i - 1];
      const templateName = suffixTemplate?.name ?? 'Baseline';
      let prompt = basePrompt;

      if (suffixTemplate) {
        prompt = appendPromptPart(prompt, suffixTemplate.suffix);
      }

      if (this.config.aggregation === 'header_merge') {
        prompt = appendPromptPart(
          prompt,
          this.buildHeaderMergeInstruction({ index, count: safeCount, templateName })
        );
      }

      variants.push({ index, prompt, templateName });
    }

    return variants;
  }

  async dispatch(request: RecognitionRequest, provider: RecognitionProvider): Promise<ParallelDispatchResult> {
    if (!this.config.enabled || this.config.promptCount <= 1) {
      const result = await provider.recognize(request);
      const variant = this.variantFromRecognitionResult(1, 'Baseline', result);
      return {
        aggregatedText: result.text,
        variants: [variant],
        dispatchedCount: 1,
        succeededCount: result.isError ? 0 : 1,
        failedCount: result.isError ? 1 : 0,
        aggregation: this.config.aggregation,
        isError: Boolean(result.isError)
      };
    }

    const variants = this.generateVariants(request.prompt, this.config.promptCount);
    const settled = await Promise.allSettled(
      variants.map(variant => provider.recognize({ ...request, prompt: variant.prompt }))
    );

    const variantResults = settled.map((settledResult, i): ParallelVariantResult => {
      const variant = variants[i];
      if (settledResult.status === 'fulfilled') {
        return this.variantFromRecognitionResult(variant.index, variant.templateName, settledResult.value);
      }

      return {
        index: variant.index,
        status: 'failed',
        templateName: variant.templateName,
        errorMessage: sanitizeFailureReason(settledResult.reason)
      };
    });

    const succeededCount = variantResults.filter(isSuccessfulVariant).length;
    const failedCount = variantResults.length - succeededCount;

    if (succeededCount === 0) {
      return {
        aggregatedText: this.buildTotalFailureText(variantResults, variants.length),
        variants: variantResults,
        dispatchedCount: variants.length,
        succeededCount,
        failedCount,
        aggregation: this.config.aggregation,
        isError: true
      };
    }

    const aggregatedText = await this.aggregateSuccessfulResults(variantResults, provider, variants.length);

    return {
      aggregatedText,
      variants: variantResults,
      dispatchedCount: variants.length,
      succeededCount,
      failedCount,
      aggregation: this.config.aggregation,
      isError: false
    };
  }

  private variantFromRecognitionResult(
    index: number,
    templateName: string,
    result: RecognitionResult
  ): ParallelVariantResult {
    if (result.isError) {
      return {
        index,
        status: 'failed',
        templateName,
        result,
        errorMessage: sanitizeFailureReason(result.text)
      };
    }

    return {
      index,
      status: 'success',
      templateName,
      result
    };
  }

  private async aggregateSuccessfulResults(
    variants: ParallelVariantResult[],
    provider: RecognitionProvider,
    totalCount: number
  ): Promise<string> {
    switch (this.config.aggregation) {
      case 'all_return':
        return this.aggregateAllReturn(variants, totalCount);
      case 'header_merge':
        return this.aggregateHeaderMerge(variants, totalCount, 'header_merge');
      case 'llm_merge':
        return this.aggregateLlmMerge(variants, provider, totalCount);
    }
  }

  private aggregateAllReturn(variants: ParallelVariantResult[], totalCount: number): string {
    const successfulBlocks = variants
      .filter(isSuccessfulVariant)
      .map(variant => this.formatVariantBlock(variant, totalCount));

    const body = successfulBlocks.join(HEADER_SEPARATOR);
    const failureMetadata = this.formatFailureMetadata(variants);

    return failureMetadata ? `${body}${HEADER_SEPARATOR}${failureMetadata}` : body;
  }

  private aggregateHeaderMerge(
    variants: ParallelVariantResult[],
    totalCount: number,
    aggregationLabel: 'header_merge' | 'llm_merge',
    note?: string
  ): string {
    const successfulBlocks = variants
      .filter(isSuccessfulVariant)
      .map(variant => this.formatVariantBlock(variant, totalCount));

    const metadata = this.formatMetadataLine(variants, totalCount, aggregationLabel);
    const parts = [...successfulBlocks];
    if (note) {
      parts.push(`_Synthesis note: ${sanitizeFailureReason(note)}_`);
    }
    parts.push(metadata);

    return parts.join(HEADER_SEPARATOR);
  }

  private async aggregateLlmMerge(
    variants: ParallelVariantResult[],
    provider: RecognitionProvider,
    totalCount: number
  ): Promise<string> {
    if (!provider.synthesizeText) {
      return this.aggregateHeaderMerge(
        variants,
        totalCount,
        'llm_merge',
        'llm_merge synthesis unavailable because the provider has no text-only synthesis capability; returned deterministic header-style aggregation.'
      );
    }

    const synthesisPrompt = this.buildSynthesisPrompt(variants, totalCount);

    try {
      const synthesisResult = await provider.synthesizeText(synthesisPrompt);
      if (synthesisResult.isError) {
        return this.aggregateHeaderMerge(
          variants,
          totalCount,
          'llm_merge',
          `llm_merge synthesis failed: ${synthesisResult.text}; returned deterministic header-style aggregation.`
        );
      }

      return `${synthesisResult.text}${HEADER_SEPARATOR}${this.formatMetadataLine(variants, totalCount, 'llm_merge')}`;
    } catch (error) {
      return this.aggregateHeaderMerge(
        variants,
        totalCount,
        'llm_merge',
        `llm_merge synthesis rejected: ${error instanceof Error ? error.message : String(error)}; returned deterministic header-style aggregation.`
      );
    }
  }

  private buildSynthesisPrompt(variants: ParallelVariantResult[], totalCount: number): string {
    const responseBlocks = variants
      .filter(isSuccessfulVariant)
      .map(variant => [
        `<ensemble-response index="${variant.index}" total="${totalCount}" template="${escapeAttribute(variant.templateName)}">`,
        `## Ensemble Agent ${variant.index} of ${totalCount} (${variant.templateName})`,
        variant.result.text,
        '</ensemble-response>'
      ].join('\n'))
      .join('\n\n');

    const failureMetadata = this.formatFailureMetadata(variants) || 'None.';

    return [
      this.config.llmMergePrompt.trim(),
      '',
      'Additional synthesis constraints:',
      '- Use only the bounded ensemble response blocks below as evidence.',
      '- Deduplicate repeated facts and reorganize information only; do not add unsupported facts.',
      '- Preserve disagreements, uncertainty, and low-confidence observations explicitly.',
      '- Keep all configured Markdown sections present; if evidence is missing, write "Not observed" or "Unclear".',
      '',
      'Configured Markdown template to preserve when applicable:',
      this.config.headerMergeTemplate.trim(),
      '',
      'Bounded ensemble responses:',
      responseBlocks,
      '',
      'Sanitized failure metadata:',
      failureMetadata,
      '',
      'Return only the synthesized Markdown response.'
    ].join('\n');
  }

  private buildHeaderMergeInstruction(args: { index: number; count: number; templateName: string }): string {
    const resolvedTemplate = this.resolveTemplatePlaceholders(this.config.headerMergeTemplate, args);

    return [
      `You are Ensemble Agent ${args.index} of ${args.count} (${args.templateName}).`,
      "Fill the Markdown template below using only evidence from the media and the user's prompt.",
      'Do not delete or rename sections. If a section has no direct evidence, write "Not observed" or "Unclear".',
      'Preserve uncertainty and alternatives instead of guessing.',
      '',
      resolvedTemplate
    ].join('\n');
  }

  private resolveTemplatePlaceholders(template: string, args: { index: number; count: number; templateName: string }): string {
    return template
      .replace(/{{\s*agentIndex\s*}}/g, String(args.index))
      .replace(/{{\s*agentCount\s*}}/g, String(args.count))
      .replace(/{{\s*templateName\s*}}/g, args.templateName);
  }

  private resolveSuffixTemplates(count: number): PromptTemplate[] {
    if (count <= 0) {
      return [];
    }

    const selected: PromptTemplate[] = [];
    const seenNames = new Set<string>();
    const addTemplate = (template: PromptTemplate): void => {
      const name = template.name.trim();
      const suffix = template.suffix;
      if (!name || !suffix.trim() || seenNames.has(name) || selected.length >= count) {
        return;
      }
      seenNames.add(name);
      selected.push({ name, suffix });
    };

    for (const template of this.config.promptTemplates) {
      addTemplate(template);
    }
    for (const template of BUILT_IN_PROMPT_TEMPLATES) {
      addTemplate(template);
    }

    let fallbackIndex = 1;
    while (selected.length < count) {
      selected.push({
        name: `Variant${fallbackIndex}`,
        suffix: ` Consider the media from an additional independent perspective (${fallbackIndex}).`
      });
      fallbackIndex++;
    }

    return selected;
  }

  private formatVariantBlock(variant: SuccessfulVariant, totalCount: number): string {
    return `## Ensemble Agent ${variant.index} of ${totalCount} (${variant.templateName})\n\n${variant.result.text}`;
  }

  private formatMetadataLine(
    variants: ParallelVariantResult[],
    totalCount: number,
    aggregationLabel: 'header_merge' | 'llm_merge'
  ): string {
    const succeeded = variants.filter(isSuccessfulVariant).length;
    const failed = variants.length - succeeded;
    const failureSummary = this.formatFailureSummary(variants);
    const failureText = failureSummary ? `; failures=${failureSummary}` : '';
    return `_Parallel inference metadata: dispatched=${totalCount}; succeeded=${succeeded}; failed=${failed}; aggregation=${aggregationLabel}${failureText}._`;
  }

  private formatFailureMetadata(variants: ParallelVariantResult[]): string {
    const failureSummary = this.formatFailureSummary(variants);
    return failureSummary ? `_Parallel inference failures: ${failureSummary}._` : '';
  }

  private formatFailureSummary(variants: ParallelVariantResult[]): string {
    return variants
      .filter(variant => variant.status === 'failed')
      .map(variant => `Agent ${variant.index} (${variant.templateName}): ${variant.errorMessage ?? 'failed'}`)
      .join('; ');
  }

  private buildTotalFailureText(variants: ParallelVariantResult[], totalCount: number): string {
    const failureSummary = this.formatFailureSummary(variants) || 'no compact failure reason returned';
    return `Parallel inference failed for all ${totalCount} variant(s). Sanitized reasons: ${failureSummary}.`;
  }
}

function appendPromptPart(basePrompt: string, addition: string): string {
  if (!addition) {
    return basePrompt;
  }
  if (!basePrompt) {
    return addition;
  }
  return /^\s/.test(addition) ? `${basePrompt}${addition}` : `${basePrompt}\n\n${addition}`;
}

function isSuccessfulVariant(variant: ParallelVariantResult): variant is SuccessfulVariant {
  const result = variant.result;
  return variant.status === 'success' && result !== undefined && !result.isError;
}

function escapeAttribute(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export function sanitizeFailureReason(reason: unknown): string {
  const raw = reason instanceof Error ? reason.message : String(reason ?? 'unknown error');
  const compact = raw
    .replace(/data:[^\s;,]+;base64,[A-Za-z0-9+/=]+/gi, 'data:[redacted]')
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]')
    .replace(/\b(api[_-]?key|token|password|secret)\s*[:=]\s*[^\s,;]+/gi, '$1=[redacted]')
    .replace(/\b(?:sk|pk|AIza|ya29)[A-Za-z0-9._~+/=-]{12,}\b/g, '[redacted]')
    .replace(/\b[A-Za-z0-9+/=]{80,}\b/g, '[redacted-long-token]')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();

  if (!compact) {
    return 'unknown error';
  }

  return compact.length > FAILURE_REASON_MAX_LENGTH
    ? `${compact.slice(0, FAILURE_REASON_MAX_LENGTH - 3)}...`
    : compact;
}