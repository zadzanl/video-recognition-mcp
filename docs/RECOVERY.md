<!--
status: active
phase: change-b-group-7-documentation-and-verification
sprint: gemini-model-fallback-and-rate-limit-recovery
last_modified: 2026-08-08
agent_notes: "Canonical operator guide for bounded Gemini recovery, optional backup, rollback, and credential incidents."
insights: "Recovery is opt-in and bounded; cooldown is process-local, and the final backup is neither capability-probed nor a recovery guarantee."
-->

# Provider Recovery Reference

This is the canonical operator guide for Gemini model recovery and the optional final OpenAI-compatible backup. Provider selection, credentials, endpoint safety, media containment, and the base provider variables remain documented in the [main README](../README.md#configuration).

Recovery is disabled by configuration rather than inferred from credentials. Enabling any fallback can add latency, provider calls, cost, and data-sharing scope, so operators must choose every ordered Gemini candidate, backup endpoint, and backup model deliberately.

## Route and Configuration Semantics

There is no default fallback route or hard-coded model chain.

- With no `GEMINI_MODELS`, an unpinned call invokes Change A's canonical `GEMINI_MODEL` or compatibility-default model exactly once.
- One unique candidate in `GEMINI_MODELS` remains a one-candidate route and is invoked at most once. Multiple candidates are trimmed, deduplicated, and considered sequentially in declared order.
- A tool call with an explicit `modelname` is pinned to that model for one attempt. It bypasses route position and cooldown for the current call, never falls through to another Gemini model or provider, and does not mutate the configured route. A transient pinned failure can cool that model for later unpinned calls.
- Structured HTTP 403 evidence and billing failures are intentionally and unconditionally fail-fast. Billing, quota, exhausted, rate, retry, or allowlisted-looking body prose does not permit a later candidate or backup.
- Backup credentials do not enable backup. `GEMINI_BACKUP_ENABLED=true` is the required affirmative switch, and all canonical OpenAI-compatible settings—including `OPENAI_COMPATIBLE_API_KEY`, `OPENAI_COMPATIBLE_BASE_URL`, `OPENAI_COMPATIBLE_MODEL`, and `ALLOWED_MEDIA_ROOTS`—must be complete. Any other switch value fails startup; omission or `false` leaves backup disabled and ignores unused backup settings.

The Change B recovery controls are:

| Variable | Default | Allowed values and behavior |
|---|---:|---|
| `GEMINI_MODELS` | No list | Comma-separated ordered Gemini candidates. It cannot be supplied together with `GEMINI_MODEL`. |
| `GEMINI_MAX_ATTEMPTS` | `4` | Integer from `1` through `8`; shared by started Gemini and backup invocations. |
| `GEMINI_RECOVERY_DEADLINE_SECONDS` | `30` | Integer from `1` through `120`; soft deadline for starting recovery work after preparation. |
| `GEMINI_BASE_BACKOFF_MS` | `250` | Integer from `0` through `5000`. |
| `GEMINI_MAX_BACKOFF_MS` | `2000` | Integer from `0` through `10000`, not less than the base backoff. |
| `GEMINI_COOLDOWN_SECONDS` | `60` | Integer from `0` through `600`. |
| `GEMINI_BACKUP_ENABLED` | `false` | Exact `true` affirmatively enables a completely configured final backup; exact `false` disables it. |

Explicit invalid recovery values fail startup. They are not clamped, rounded, coerced, or replaced with defaults.

## Attempts, Deadlines, and Backoff

Media validation, preparation, upload, and Gemini video processing happen before recovery starts and retain their independent timeout, currently up to 300 seconds. Preparation failure starts no provider invocation and no backup. After successful preparation, `attemptsUsed` starts at zero and a fresh soft recovery start deadline begins immediately before the first Gemini generation attempt.

Only started provider invocations count as attempts. The router increments once immediately before each Gemini or backup invocation. Validation, preparation, and candidates skipped for cooldown or eligibility do not count and do not create attempt-number gaps. Each unpinned Gemini candidate is invoked at most once, and total invocations cannot exceed `GEMINI_MAX_ATTEMPTS`.

The recovery deadline is a soft **start** deadline, not a request cancellation timeout. No delay or invocation starts when the clock is at or after it. Once started, a request retains the adapter's independent timeout (60 seconds by default and at most 120 seconds for the OpenAI-compatible adapter). A success arriving after the recovery deadline is accepted. A failure arriving after it starts no later delay, Gemini candidate, or backup. Post-preparation wall time can therefore exceed the recovery deadline by at most one independently bounded in-flight provider timeout.

Eligible transitions use capped exponential backoff. A valid adapter-normalized `retryAfterMs` replaces normal backoff but is still capped by `GEMINI_MAX_BACKOFF_MS` and the remaining soft start-deadline time. Missing, malformed, fractional, negative, non-finite, overflowing, or unsupported retry timing authorizes nothing and falls back to normal capped exponential backoff. The router does not parse raw provider text or headers for timing.

## Conservative HTTP 429 Policy

Every exact structured HTTP 429 evidence is treated as transient under the unchanged allowlist. Routing does not infer RPM, TPM, daily/RPD, spend, project/shared, or any other quota subtype from provider prose, uncharacterized SDK fields, or arbitrary JSON details.

Gemini candidates can share project quota. Daily, spend, project/shared, or other long-window exhaustion can therefore consume later configured Gemini attempts without recovering. That wasted cost is bounded by the configured attempt and start-deadline limits. This is a deliberate conservative false positive: bounded attempts are preferred over making routing decisions from provider prose.

The SDK characterization and request-count gate must be rerun whenever the resolved `@google/genai` version or dependency resolution changes, including a later resolution within the declared version range. One router attempt must remain one upstream request. If a later SDK silently retries, those retries must be disabled or every underlying request must be counted within the same `GEMINI_MAX_ATTEMPTS` cap before the change can pass verification.

## Process-Local Cooldown

Transient Gemini and transient backup failures enter the same in-memory cooldown keyed by provider and model. The cooldown is shared by requests and callers in one process, so one caller's transient failure can make a later unpinned call skip that candidate. Pins bypass an active cooldown for their current one attempt but can create or refresh cooldown for later unpinned calls.

Cooldown state is bounded to 64 entries, expires lazily, never polls, and is discarded on process restart. When full, the earliest-expiring entry is evicted, with insertion order breaking equal-expiry ties. Separate server processes or deployment instances do not share cooldown state. An all-cooling route terminates immediately or considers the explicitly enabled backup within the remaining budget; it never waits for capacity.

## Optional Final Backup

The OpenAI-compatible backup is an explicitly enabled, optional, final, last resort (last-resort) path—not a recovery guarantee. It is considered at most once only after every Gemini candidate transiently failed or was skipped for an active transient-failure cooldown, no fail-fast condition occurred, no `modelname` pin was supplied, and attempt/deadline budget remains.

The operator is responsible for selecting a configured backup model that supports the requested image, audio, or video media kind. The server has no capability registry, performs no capability probe, silently substitutes no model, and never forwards or translates a Gemini pin to backup. Unsupported media fails fast under the backup adapter's normalized category.

Backup may be unavailable, reject the requested modality, share exhausted project or long-window limits, or fail under its own quota or timeout. Its invocation increases latency and cost and may send the prompt and media to another operator-selected endpoint with different privacy, retention, residency, and billing terms. Review those terms and the configured `ALLOWED_MEDIA_ROOTS` before enabling it.

Backup is always the final attempt. Authentication, permission, HTTP 403, billing, unsupported-media, safety, invalid-request, malformed-response, and unknown backup failures are final; no second backup, provider, or delay follows. A transient backup failure also creates process-local cooldown, which can suppress backup on a later request in that process.

## Rollback

For immediate operational rollback, set `GEMINI_BACKUP_ENABLED=false`, remove `GEMINI_MODELS` and the other Change B recovery settings, and restart all instances. This returns unpinned Gemini calls to Change A's canonical one-model, one-attempt behavior. Disabling recovery does not revoke any credential.

A combined code rollback has a mandatory order:

1. Disable backup and all recovery configuration in every deployment.
2. Remove Change B's recovery implementation.
3. Rerun Change A's provider, configuration, tool, transport, and compatibility tests.
4. Only after those tests pass, restore direct Gemini injection if that is the intended earlier architecture.

Change A must not be rolled back while Change B remains installed.

## Backup Credential Incident Response

If backup credentials may be exposed or a backup endpoint may be misrouted, perform these actions in order:

1. **Disable backup** in every affected deployment so no further backup egress starts.
2. **Revoke** each affected credential at the provider.
3. **Rotate** replacement credentials through the approved secret-management process.
4. **Remove stale secrets** from MCP client configuration, deployment configuration, environment sources, and secret stores.
5. **Restart every affected instance** to load replacements and discard process-local cooldown and in-memory configuration state.
6. **Inspect only sanitized diagnostics** for attempt categories, models, timing, and routing outcomes. Do not copy credentials, authorization values, prompts, paths, media, encoded content, provider bodies, or unsanitized messages into incident records.

Disabling backup is containment, not revocation; complete all steps even when backup has already been turned off.