/**
 * status: active
 * phase: change-b-group-6-observability
 * sprint: gemini-model-fallback-and-rate-limit-recovery
 * last_modified: 2026-08-08
 * agent_notes: "Shared MCP tool failure mapper with strict terminal/operator channel separation."
 * insights: "Terminal output never reads safeMessage. Unknown errors are not inspected or coerced."
 */

import type { MediaKind } from '../types/provider.js';
import {
  escapeAndTruncateDiagnostic,
  getRecoveryTerminalMessage,
  sanitizeOperatorMessage
} from '../services/recovery-diagnostics.js';
import { isProviderFailure } from '../services/provider-failure.js';

export interface RecognitionToolFailureMessages {
  readonly terminalMessage: string;
  readonly operatorMessage: string;
}

export const mapRecognitionToolFailure = (
  caught: unknown,
  mediaKind: MediaKind
): RecognitionToolFailureMessages => {
  if (!isProviderFailure(caught)) {
    return {
      terminalMessage: `Recognition failed: media=${mediaKind}; category=unknown`,
      operatorMessage: `Recognition tool failed: media=${mediaKind}; category=unknown`
    };
  }

  const trustedTerminal = getRecoveryTerminalMessage(caught);
  return {
    terminalMessage: trustedTerminal
      ?? `Recognition failed: provider=${caught.provider}; media=${mediaKind}; category=${caught.category}`,
    operatorMessage: escapeAndTruncateDiagnostic(
      `Recognition tool failed: provider=${caught.provider}; media=${mediaKind}; category=${caught.category}; detail="${sanitizeOperatorMessage(caught.safeMessage)}"`
    )
  };
};