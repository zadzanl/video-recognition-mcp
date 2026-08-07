/**
 * status: active
 * phase: change-b-group-3-ordered-fallback
 * sprint: gemini-model-fallback-and-rate-limit-recovery
 * last_modified: 2026-08-07
 * agent_notes: "Request-local prepared-media router with a soft pre-start deadline and no in-flight cancellation race."
 * insights: "The injected invoker is the bounded test boundary; production Gemini generation intentionally has no independent adapter timeout. Group 4 may add sleep/random and cooldown-backed eligibility at this seam. Terminal model text uses complete escaped units, ASCII marker [...], and a 4096-byte cap."
 */

import type {
  ProviderFailure,
  ProviderFailureCategory,
  RecognitionResult
} from '../types/provider.js';
import {
  classifyNormalizedGeminiFailure,
  type NormalizedGeminiFailure
} from './gemini-error-classifier.js';

export interface StartedGeminiAttempt {
  readonly provider: 'gemini';
  readonly model: string;
  readonly attempt: number;
  readonly category: ProviderFailureCategory;
}

export type GeminiTerminalReason =
  | 'route-exhausted'
  | 'deadline-terminated'
  | 'envelope-unusable';

export type GeminiRouteOutcome =
  | { readonly kind: 'success'; readonly result: RecognitionResult }
  | { readonly kind: 'fail-fast'; readonly failure: ProviderFailure }
  | {
      readonly kind: 'terminal';
      readonly reason: GeminiTerminalReason;
      readonly attemptsUsed: number;
      readonly attempts: readonly StartedGeminiAttempt[];
    };

export interface GeminiRouterRuntime {
  readonly now: () => number;
  readonly invokePreparedModel: (model: string) => Promise<RecognitionResult>;
  readonly isCandidateEligible?: (model: string) => boolean;
}

export interface GeminiRouteInput {
  readonly candidates: readonly string[];
  readonly pinned: boolean;
  readonly maxAttempts: number;
  readonly deadlineSeconds: number;
  readonly deadlineStartedAt: number;
}

const isNormalizedFailure = (value: unknown): value is NormalizedGeminiFailure => {
  if (typeof value !== 'object' || value === null) return false;
  try {
    const candidate = value as Partial<NormalizedGeminiFailure>;
    return (candidate.envelopeState === 'usable'
      || candidate.envelopeState === 'unusable'
      || candidate.envelopeState === 'not-applicable')
      && candidate.failure instanceof Error;
  } catch {
    return false;
  }
};

export const runPreparedGeminiRoute = async (
  input: GeminiRouteInput,
  runtime: GeminiRouterRuntime
): Promise<GeminiRouteOutcome> => {
  const deadline = input.deadlineStartedAt + input.deadlineSeconds * 1000;
  const seen = new Set<string>();
  const attempts: StartedGeminiAttempt[] = [];
  let attemptsUsed = 0;

  for (const model of input.candidates) {
    if (seen.has(model)) continue;
    seen.add(model);
    if (!input.pinned && runtime.isCandidateEligible?.(model) === false) continue;
    if (attemptsUsed >= input.maxAttempts) break;
    if (runtime.now() >= deadline) {
      return { kind: 'terminal', reason: 'deadline-terminated', attemptsUsed, attempts };
    }

    attemptsUsed += 1;
    try {
      const result = await runtime.invokePreparedModel(model);
      return { kind: 'success', result };
    } catch (caught) {
      if (!isNormalizedFailure(caught)) {
        return {
          kind: 'fail-fast',
          failure: caught instanceof Error
            ? caught as ProviderFailure
            : new Error('Gemini routing invocation failed.') as ProviderFailure
        };
      }
      const decision = classifyNormalizedGeminiFailure(caught);
      attempts.push({
        provider: 'gemini', model, attempt: attemptsUsed, category: caught.failure.category
      });
      if (decision.kind === 'fail-fast' && decision.terminalReason === 'envelope-unusable') {
        return { kind: 'terminal', reason: 'envelope-unusable', attemptsUsed, attempts };
      }
      if (runtime.now() >= deadline) {
        return { kind: 'terminal', reason: 'deadline-terminated', attemptsUsed, attempts };
      }
      if (decision.kind === 'fail-fast') {
        return { kind: 'fail-fast', failure: caught.failure };
      }
      if (input.pinned) break;
    }
  }

  return { kind: 'terminal', reason: 'route-exhausted', attemptsUsed, attempts };
};

export const GEMINI_TERMINAL_MAX_BYTES = 4096;
export const GEMINI_TERMINAL_TRUNCATION_MARKER = '[...]';
const MODEL_FIELD_MAX_BYTES = 320;

const escapedUnits = (value: string): string[] => [...value].map(character => {
  const codePoint = character.codePointAt(0)!;
  const isC0C1 = codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f);
  const isBidi = codePoint === 0x061c || codePoint === 0x200e || codePoint === 0x200f
    || (codePoint >= 0x202a && codePoint <= 0x202e)
    || (codePoint >= 0x2066 && codePoint <= 0x2069);
  if (isC0C1 || isBidi) return `\\u${codePoint.toString(16).toUpperCase().padStart(4, '0')}`;
  if (character === '\\') return '\\\\';
  if (character === '"') return '\\"';
  return character;
});

const boundedEscapedModel = (model: string): string => {
  const units = escapedUnits(model);
  if (Buffer.byteLength(units.join(''), 'utf8') <= MODEL_FIELD_MAX_BYTES) return units.join('');
  const budget = MODEL_FIELD_MAX_BYTES - Buffer.byteLength(GEMINI_TERMINAL_TRUNCATION_MARKER);
  let bytes = 0;
  let output = '';
  for (const unit of units) {
    const unitBytes = Buffer.byteLength(unit, 'utf8');
    if (bytes + unitBytes > budget) break;
    output += unit;
    bytes += unitBytes;
  }
  return output + GEMINI_TERMINAL_TRUNCATION_MARKER;
};

export const formatGeminiTerminalMessage = (
  reason: GeminiTerminalReason,
  attempts: readonly StartedGeminiAttempt[]
): string => {
  const records = attempts.map(attempt =>
    `{provider=gemini,model="${boundedEscapedModel(attempt.model)}",attempt=${attempt.attempt},category=${attempt.category}}`
  );
  const output = `Gemini recovery terminated: reason=${reason}; attempts=[${records.join(',')}]`;
  if (Buffer.byteLength(output, 'utf8') > GEMINI_TERMINAL_MAX_BYTES) {
    // With maxAttempts <= 8 and the per-model budget this is unreachable for
    // validated inputs; retain a fail-closed fixed terminal string if contracts drift.
    return `Gemini recovery terminated: reason=${reason}; attempts=${GEMINI_TERMINAL_TRUNCATION_MARKER}`;
  }
  return output;
};