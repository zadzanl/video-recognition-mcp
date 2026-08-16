/**
 * status: active
 * phase: change-b-group-6-observability
 * sprint: gemini-model-fallback-and-rate-limit-recovery
 * last_modified: 2026-08-08
 * agent_notes: "Request-local prepared-media router imports shared closed diagnostics; event wiring follows in Group 6 Phase 2."
 * insights: "Clock, sleeper, cooldown state, and invoker are injected. Terminal escaping and UTF-8 bounding are now single-sourced in recovery-diagnostics."
 */

import type { ProviderFailure, RecognitionResult } from '../types/provider.js';
import {
  classifyNormalizedGeminiFailure,
  type NormalizedGeminiFailure
} from './gemini-error-classifier.js';
import type { ProviderModelCooldownStore } from './provider-cooldown-store.js';
import { createProviderFailure, isProviderFailure } from './provider-failure.js';
import {
  emitRecoveryDiagnostic,
  formatRecoveryTerminalMessage,
  RECOVERY_DIAGNOSTIC_MAX_BYTES,
  RECOVERY_DIAGNOSTIC_TRUNCATION_MARKER,
  sanitizeOperatorMessage,
  type GeminiTerminalReason,
  type RecoveryDiagnosticSink,
  type StartedProviderAttempt
} from './recovery-diagnostics.js';
import type { MediaKind } from '../types/provider.js';

export type { GeminiTerminalReason, StartedProviderAttempt } from './recovery-diagnostics.js';
export type StartedGeminiAttempt = StartedProviderAttempt;

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
  readonly diagnosticSink?: RecoveryDiagnosticSink;
  readonly backup?: {
    readonly provider: string;
    readonly model: string;
    readonly invoke: () => Promise<RecognitionResult>;
  };
}

export interface GeminiRouteInput {
  readonly mediaKind: MediaKind;
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
  let recoveryTransition = false;
  const emit = (event: Parameters<NonNullable<GeminiRouterRuntime['diagnosticSink']>>[0]): void =>
    emitRecoveryDiagnostic(runtime.diagnosticSink, event);
  const terminal = (reason: GeminiTerminalReason): GeminiRouteOutcome => {
    emit({ kind: 'route-exhausted', mediaKind: input.mediaKind, reason, attemptsUsed });
    return { kind: 'terminal', reason, attemptsUsed, attempts };
  };

  for (const [candidateIndex, model] of candidates.entries()) {
    if (!input.pinned && runtime.cooldowns.isCooling('gemini', model, runtime.now())) {
      exhaustedCandidates.add(model);
      recoveryTransition = true;
      emit({ kind: 'cooldown-skipped', provider: 'gemini', model, mediaKind: input.mediaKind });
      continue;
    }
    if (attemptsUsed >= input.maxAttempts) break;
    if (runtime.now() >= deadline) {
      return terminal('deadline-terminated');
    }

    attemptsUsed += 1;
    emit({
      kind: 'attempt-started', provider: 'gemini', model,
      mediaKind: input.mediaKind, attempt: attemptsUsed
    });
    try {
      const result = await runtime.invokePreparedModel(model);
      if (recoveryTransition) {
        emit({
          kind: 'fallback-succeeded', provider: 'gemini', model,
          mediaKind: input.mediaKind, attempt: attemptsUsed
        });
      }
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
      recoveryTransition = true;
      emit({
        kind: 'attempt-classified', provider: 'gemini', model,
        mediaKind: input.mediaKind, attempt: attemptsUsed,
        category: caught.failure.category,
        operatorMessage: sanitizeOperatorMessage(caught.failure.safeMessage)
      });
      if (decision.kind === 'fail-fast' && decision.terminalReason === 'envelope-unusable') {
        return terminal('envelope-unusable');
      }
      if (decision.kind === 'fallback-eligible') {
        exhaustedCandidates.add(model);
        runtime.cooldowns.recordTransientFailure(
          'gemini', model, runtime.now(), input.cooldownSeconds * 1000
        );
      }
      if (runtime.now() >= deadline) {
        return terminal('deadline-terminated');
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
        return terminal('deadline-terminated');
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
      emit({
        kind: 'cooldown-skipped', provider: backup.provider, model: backup.model,
        mediaKind: input.mediaKind
      });
      return terminal('route-exhausted');
    }
    if (attemptsUsed >= input.maxAttempts) {
      return terminal('route-exhausted');
    }
    if (runtime.now() >= deadline) {
      return terminal('deadline-terminated');
    }
    attemptsUsed += 1;
    emit({
      kind: 'attempt-started', provider: backup.provider, model: backup.model,
      mediaKind: input.mediaKind, attempt: attemptsUsed
    });
    try {
      const result = await backup.invoke();
      emit({
        kind: 'fallback-succeeded', provider: backup.provider, model: backup.model,
        mediaKind: input.mediaKind, attempt: attemptsUsed
      });
      return { kind: 'success', result };
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
      emit({
        kind: 'attempt-classified', provider: backup.provider, model: backup.model,
        mediaKind: input.mediaKind, attempt: attemptsUsed, category: failure.category,
        operatorMessage: sanitizeOperatorMessage(failure.safeMessage)
      });
      if (['rate-limit', 'timeout', 'temporary-service', 'network'].includes(failure.category)) {
        runtime.cooldowns.recordTransientFailure(
          backup.provider, backup.model, runtime.now(), input.cooldownSeconds * 1000
        );
      }
      return terminal(runtime.now() >= deadline ? 'deadline-terminated' : 'backup-exhausted');
    }
  }

  return terminal('route-exhausted');
};

export const GEMINI_TERMINAL_MAX_BYTES = RECOVERY_DIAGNOSTIC_MAX_BYTES;
export const GEMINI_TERMINAL_TRUNCATION_MARKER = RECOVERY_DIAGNOSTIC_TRUNCATION_MARKER;
export const formatGeminiTerminalMessage = (
  reason: GeminiTerminalReason,
  attempts: readonly StartedProviderAttempt[]
): string => formatRecoveryTerminalMessage('image', reason, attempts);
