/**
 * Gemini API error classification for model fallback decisions.
 *
 * status: ACTIVE
 * phase: MVP
 * sprint: unknown
 * last_modified: 2026-06-19
 * agent_notes: "Pure function to classify Gemini generation errors as retryable or fail-fast for fallback loop."
 */

/**
 * Shape of errors thrown by @google/genai SDK.
 *
 * The SDK may surface errors with numeric status, gRPC-style string status,
 * or string code fields (e.g. RESOURCE_EXHAUSTED). Normalize all forms.
 */
export interface GeminiApiErrorShape {
  name?: string;
  message?: string;
  /** HTTP status (number) or gRPC status string (e.g. "UNAVAILABLE"). */
  status?: number | string;
  /** gRPC/API error code as number (e.g. 429) or string (e.g. "RESOURCE_EXHAUSTED"). */
  code?: number | string;
  cause?: unknown;
}

export interface ErrorClassification {
  /** Whether the error is transient and the caller should try the next model. */
  retryable: boolean;
  /** Compact human-readable reason for logs and exhaustion messages. */
  reason: string;
}

function isGeminiApiError(err: unknown): err is GeminiApiErrorShape {
  if (typeof err !== 'object' || err === null) return false;
  const e = err as Record<string, unknown>;
  return (
    typeof e.name === 'string' ||
    typeof e.message === 'string' ||
    typeof e.status === 'number' ||
    typeof e.status === 'string' ||
    typeof e.code === 'number' ||
    typeof e.code === 'string'
  );
}

/**
 * Normalize status, code, name, and message into a combined uppercase token
 * string and extract a numeric status value when available.
 */
function normalizeError(err: GeminiApiErrorShape): { statusNum: number | undefined; tokens: string } {
  const parts: string[] = [];
  let statusNum: number | undefined = undefined;

  // Status: numeric -> statusNum; string -> token (and maybe parse)
  if (typeof err.status === 'number') {
    statusNum = err.status;
  } else if (typeof err.status === 'string') {
    parts.push(err.status.toUpperCase());
    const parsed = parseInt(err.status, 10);
    if (!isNaN(parsed)) statusNum = parsed;
  }

  // Code: numeric -> statusNum (if not already set); string -> token
  if (typeof err.code === 'number') {
    if (statusNum === undefined) statusNum = err.code;
  } else if (typeof err.code === 'string') {
    parts.push(err.code.toUpperCase());
    const parsed = parseInt(err.code, 10);
    if (!isNaN(parsed) && statusNum === undefined) statusNum = parsed;
  }

  if (err.name) parts.push(err.name.toUpperCase());
  if (err.message) parts.push(err.message.toUpperCase());

  return { statusNum, tokens: parts.join(' ') };
}

/**
 * Classify a raw error from a Gemini generation attempt.
 *
 * Fallback-eligible (retryable): 429, 500, 503; RESOURCE_EXHAUSTED, INTERNAL,
 * UNAVAILABLE, DEADLINE_EXCEEDED; timeout/network transient codes.
 *
 * Fail-fast: auth (401/403), billing (402), permission, invalid request (400),
 * unsupported feature, and unknown errors as a safe default.
 *
 * Specific fail-fast tokens (PERMISSION_DENIED, BILLING, FAILED_PRECONDITION)
 * are checked before generic status codes so a 403 with PERMISSION_DENIED
 * returns a precise diagnostic instead of generic "forbidden".
 */
export function classifyGeminiError(error: unknown): ErrorClassification {
  if (isGeminiApiError(error)) {
    const { statusNum, tokens } = normalizeError(error);

    // --- Fail-fast tokens (checked before generic status codes) ---
    // This order ensures 403 + PERMISSION_DENIED/BILLING/FAILED_PRECONDITION
    // gets a specific reason, not just "forbidden (403)".

    const isRateOrTierLimit = /QUOTA|LIMIT|EXHAUSTED|RATE|TIER|FREE/.test(tokens);

    if (/PERMISSION_DENIED/.test(tokens))
      return { retryable: false, reason: 'permission denied' };
    if (/UNAUTHENTICATED/.test(tokens))
      return { retryable: false, reason: 'unauthenticated' };
    if (/BILLING/.test(tokens)) {
      if (isRateOrTierLimit) {
        return { retryable: true, reason: 'rate limit or tier constraint (billing token)' };
      }
      return { retryable: false, reason: 'billing/account issue' };
    }
    if (/FAILED_PRECONDITION/.test(tokens)) {
      if (isRateOrTierLimit) {
        return { retryable: true, reason: 'rate limit or tier constraint (precondition token)' };
      }
      return { retryable: false, reason: 'precondition/account issue' };
    }
    if (/INVALID_ARGUMENT|INVALID_REQUEST/.test(tokens))
      return { retryable: false, reason: 'invalid argument/request' };
    if (/UNSUPPORTED|NOT_FOUND/.test(tokens))
      return { retryable: false, reason: 'unsupported or not found' };

    // --- Retryable tokens ---

    if (/RESOURCE_EXHAUSTED/.test(tokens))
      return { retryable: true, reason: 'resource exhausted' };
    if (/INTERNAL/.test(tokens))
      return { retryable: true, reason: 'internal error' };
    if (/UNAVAILABLE/.test(tokens))
      return { retryable: true, reason: 'service unavailable' };
    if (/DEADLINE_EXCEEDED/.test(tokens))
      return { retryable: true, reason: 'deadline exceeded' };

    // --- Status-based classification (after token checks) ---

    if (statusNum === 429) return { retryable: true, reason: 'rate limited (429)' };
    if (statusNum === 500) return { retryable: true, reason: 'internal server error (500)' };
    if (statusNum === 503) return { retryable: true, reason: 'service unavailable (503)' };

    if (statusNum === 401) return { retryable: false, reason: 'authentication failed (401)' };
    if (statusNum === 402) return { retryable: false, reason: 'billing required (402)' };
    if (statusNum === 403) return { retryable: false, reason: 'forbidden (403)' };
    if (statusNum === 400) return { retryable: false, reason: 'invalid request (400)' };

    // Unknown API error: fail-fast by default
    if (statusNum !== undefined && statusNum >= 400)
      return { retryable: false, reason: `API error (status ${statusNum})` };
  }

  // Network/transient errors (Error instances with cause codes)
  if (error instanceof Error) {
    const msg = (error.message ?? '').toUpperCase();
    const cause = (error as { cause?: unknown }).cause;
    const causeStr = cause ? String(cause).toUpperCase() : '';
    const combined = `${msg} ${causeStr}`;

    if (/DEADLINE_EXCEEDED/.test(combined))
      return { retryable: true, reason: 'deadline exceeded' };
    if (/ETIMEDOUT/.test(combined))
      return { retryable: true, reason: 'connection timed out' };
    if (/ECONNRESET/.test(combined))
      return { retryable: true, reason: 'connection reset' };
    if (/EAI_AGAIN/.test(combined))
      return { retryable: true, reason: 'DNS lookup transient failure' };
    if (/TIMEOUT/i.test(msg) && !/DEADLINE_EXCEEDED/.test(combined))
      return { retryable: true, reason: 'timeout' };
    if (/ABORT/i.test(combined))
      return { retryable: true, reason: 'request aborted' };

    // Generic Error: fail-fast
    return { retryable: false, reason: error.message.slice(0, 200) };
  }

  // Unknown throw type: fail-fast
  return { retryable: false, reason: 'unknown error' };
}
