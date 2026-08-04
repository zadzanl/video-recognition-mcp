/**
 * status: active
 * phase: checkpoint-3-provider-contract
 * sprint: provider-foundation-first-sprint
 * last_modified: 2026-08-02
 * agent_notes: "Creates Error-compatible provider failures without exposing retained causes."
 * insights: "cause is defined non-enumerably so spread, Object.keys, and JSON omit it."
 */

import type { ProviderFailure, ProviderFailureCategory } from '../types/provider.js';

export interface ProviderFailureDetails {
  provider: ProviderFailure['provider'];
  category: ProviderFailureCategory;
  safeMessage: string;
  status?: number;
  code?: string;
  retryAfterMs?: number;
  cause?: unknown;
}

export const createProviderFailure = (details: ProviderFailureDetails): ProviderFailure => {
  const failure = new Error(details.safeMessage) as ProviderFailure;
  failure.name = 'ProviderFailure';
  failure.provider = details.provider;
  failure.category = details.category;
  failure.safeMessage = details.safeMessage;

  if (details.status !== undefined) failure.status = details.status;
  if (details.code !== undefined) failure.code = details.code;
  if (details.retryAfterMs !== undefined) failure.retryAfterMs = details.retryAfterMs;
  if (details.cause !== undefined) {
    Object.defineProperty(failure, 'cause', {
      value: details.cause,
      enumerable: false,
      configurable: true,
      writable: true
    });
  }

  return failure;
};
