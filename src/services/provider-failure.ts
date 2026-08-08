/**
 * status: implementation-ready
 * phase: phase-5-wiring
 * sprint: provider-foundation-first-sprint
 * last_modified: 2026-08-05
 * agent_notes: "Phase 5 added a narrow isProviderFailure guard so the tool boundary never trusts a forged safeMessage."
 * insights: "cause is defined non-enumerably so spread, Object.keys, and JSON omit it. The guard validates Error identity, exact name, provider identity, canonical category, and string safeMessage, and tolerates hostile getters by returning false on any thrown property access. Every potentially hostile property read, including name, happens inside the try block so a throwing getter cannot bypass the guard."
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

const providerIdentifiers: ReadonlySet<string> = new Set(['gemini', 'openai-compatible']);

const failureCategories: ReadonlySet<string> = new Set<ProviderFailureCategory>([
  'configuration',
  'authentication',
  'permission',
  'billing',
  'invalid-request',
  'unsupported-media',
  'safety',
  'rate-limit',
  'timeout',
  'temporary-service',
  'network',
  'cancelled',
  'malformed-response',
  'unknown'
]);

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

export const isProviderFailure = (value: unknown): value is ProviderFailure => {
  if (!(value instanceof Error)) return false;
  try {
    const candidate = value as unknown as Record<string, unknown>;
    if (candidate.name !== 'ProviderFailure') return false;
    const provider = candidate.provider;
    const category = candidate.category;
    const safeMessage = candidate.safeMessage;
    if (typeof provider !== 'string' || !providerIdentifiers.has(provider)) return false;
    if (typeof category !== 'string' || !failureCategories.has(category)) return false;
    if (typeof safeMessage !== 'string') return false;
    return true;
  } catch {
    return false;
  }
};
