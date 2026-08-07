/**
 * status: active
 * phase: change-b-groups-4-5-recovery
 * sprint: gemini-model-fallback-and-rate-limit-recovery
 * last_modified: 2026-08-07
 * agent_notes: "Request-local prepared-media router with deterministic backoff, bounded cooldown, and soft pre-start gates."
 * insights: "Clock, sleeper, cooldown state, and invoker are injected. Timing has no randomness: retryAfterMs replaces capped exponential delay when valid."
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
import type { ProviderModelCooldownStore } from './provider-cooldown-store.js';
import { createProviderFailure, isProviderFailure } from './provider-failure.js';

export interface StartedProviderAttempt {
  readonly provider: string;
  readonly model: string;
  readonly attempt: number;
  readonly category: ProviderFailureCategory;
}

export type StartedGeminiAttempt = StartedProviderAttempt;

export type GeminiTerminalReason =
  | 'route-exhausted'
  | 'deadline-terminated'
  | 'envelope-unusable'
  | 'backup-exhausted';

export type GeminiRouteOutcome =
  | { readonly kind: 'success'; readonly result: RecognitionResult }
  | { readonly kind: 'fail-fast'; readonly failure: ProviderFailure }
  | {
      readonly kind: 'terminal';
      readonly reason: GeminiTerminalReason;
      readonly attemptsUsed: number;
      readonly attempts: readonly StartedProviderAttempt[];
    };

export interface GeminiRouterRuntime {
  readonly now: () => number;
  readonly sleep: (ms: number) => Promise<void>;
  readonly cooldowns: ProviderModelCooldownStore;
  readonly invokePreparedModel: (model: string) => Promise<RecognitionResult>;
  readonly backup?: {
    readonly provider: string;
    readonly model: string;
    readonly invoke: () => Promise<RecognitionResult>;
  };
}

export interface GeminiRouteInput {
  readonly candidates: readonly string[];
  readonly pinned: boolean;
  readonly maxAttempts: number;
  readonly deadlineSeconds: number;
  readonly deadlineStartedAt: number;
  readonly baseBackoffMs: number;
  readonly maxBackoffMs: number;
  readonly cooldownSeconds: number;
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
  const attempts: StartedProviderAttempt[] = [];
  const exhaustedCandidates = new Set<string>();
  const candidates = input.candidates.filter(model => {
    if (seen.has(model)) return false;
    seen.add(model);
    return true;
  });
  let attemptsUsed = 0;
  let transientIndex = 0;

  for (const [candidateIndex, model] of candidates.entries()) {
    if (!input.pinned && runtime.cooldowns.isCooling('gemini', model, runtime.now())) {
      exhaustedCandidates.add(model);
      continue;
    }
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
      if (decision.kind === 'fallback-eligible') {
        exhaustedCandidates.add(model);
        runtime.cooldowns.recordTransientFailure(
          'gemini', model, runtime.now(), input.cooldownSeconds * 1000
        );
      }
      if (runtime.now() >= deadline) {
        return { kind: 'terminal', reason: 'deadline-terminated', attemptsUsed, attempts };
      }
      if (decision.kind === 'fail-fast') {
        return { kind: 'fail-fast', failure: caught.failure };
      }
      if (input.pinned) break;
      if (attemptsUsed >= input.maxAttempts) break;

      const currentTransientIndex = transientIndex;
      transientIndex += 1;
      const hasLaterEligibleCandidate = candidates.slice(candidateIndex + 1).some(candidate =>
        !runtime.cooldowns.isCooling('gemini', candidate, runtime.now())
      );
      if (!hasLaterEligibleCandidate) continue;

      const retryAfterMs = Number.isSafeInteger(caught.failure.retryAfterMs)
        && (caught.failure.retryAfterMs ?? -1) >= 0
        ? caught.failure.retryAfterMs
        : undefined;
      const normalDelayMs = Math.min(
        input.maxBackoffMs,
        input.baseBackoffMs * 2 ** currentTransientIndex
      );
      const selectedDelayMs = Math.min(
        input.maxBackoffMs,
        retryAfterMs ?? normalDelayMs
      );
      const beforeSleep = runtime.now();
      if (beforeSleep >= deadline || selectedDelayMs >= deadline - beforeSleep) {
        return { kind: 'terminal', reason: 'deadline-terminated', attemptsUsed, attempts };
      }
      await runtime.sleep(selectedDelayMs);
    }
  }

  const backup = runtime.backup;
  const backupEligible = !input.pinned
    && backup !== undefined
    && candidates.length > 0
    && exhaustedCandidates.size === candidates.length;
  if (backupEligible && backup !== undefined) {
    if (runtime.cooldowns.isCooling(backup.provider, backup.model, runtime.now())) {
      return { kind: 'terminal', reason: 'route-exhausted', attemptsUsed, attempts };
    }
    if (attemptsUsed >= input.maxAttempts) {
      return { kind: 'terminal', reason: 'route-exhausted', attemptsUsed, attempts };
    }
    if (runtime.now() >= deadline) {
      return { kind: 'terminal', reason: 'deadline-terminated', attemptsUsed, attempts };
    }
    attemptsUsed += 1;
    try {
      return { kind: 'success', result: await backup.invoke() };
    } catch (caught) {
      const failure = isProviderFailure(caught)
        ? caught
        : createProviderFailure({
            provider: 'openai-compatible',
            category: 'unknown',
            safeMessage: 'OpenAI-compatible request failed.',
            cause: caught
          });
      attempts.push({
        provider: backup.provider,
        model: backup.model,
        attempt: attemptsUsed,
        category: failure.category
      });
      if (['rate-limit', 'timeout', 'temporary-service', 'network'].includes(failure.category)) {
        runtime.cooldowns.recordTransientFailure(
          backup.provider, backup.model, runtime.now(), input.cooldownSeconds * 1000
        );
      }
      return {
        kind: 'terminal',
        reason: runtime.now() >= deadline ? 'deadline-terminated' : 'backup-exhausted',
        attemptsUsed,
        attempts
      };
    }
  }

  return { kind: 'terminal', reason: 'route-exhausted', attemptsUsed, attempts };
};

export const GEMINI_TERMINAL_MAX_BYTES = 4096;
export const GEMINI_TERMINAL_TRUNCATION_MARKER = '[...]';
const MODEL_FIELD_MAX_BYTES = 320;
const PROVIDER_FIELD_MAX_BYTES = 256;

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

const boundedEscapedField = (value: string, maximumBytes: number): string => {
  const units = escapedUnits(value);
  if (Buffer.byteLength(units.join(''), 'utf8') <= maximumBytes) return units.join('');
  const budget = maximumBytes - Buffer.byteLength(GEMINI_TERMINAL_TRUNCATION_MARKER);
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
  attempts: readonly StartedProviderAttempt[]
): string => {
  const records = attempts.map(attempt =>
    `{provider="${boundedEscapedField(attempt.provider, PROVIDER_FIELD_MAX_BYTES)}",model="${boundedEscapedField(attempt.model, MODEL_FIELD_MAX_BYTES)}",attempt=${attempt.attempt},category=${attempt.category}}`
  );
  const output = `Gemini recovery terminated: reason=${reason}; attempts=[${records.join(',')}]`;
  if (Buffer.byteLength(output, 'utf8') > GEMINI_TERMINAL_MAX_BYTES) {
    // With maxAttempts <= 8 and the per-model budget this is unreachable for
    // validated inputs; retain a fail-closed fixed terminal string if contracts drift.
    return `Gemini recovery terminated: reason=${reason}; attempts=${GEMINI_TERMINAL_TRUNCATION_MARKER}`;
  }
  return output;
};
