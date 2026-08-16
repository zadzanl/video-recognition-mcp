# Provider Recovery Reference

This is the operator guide for Gemini model recovery and the optional OpenAI-compatible backup. Provider selection, credentials, endpoint safety, media containment, and the base provider variables are documented in the [main README](../README.md#configuration).

Recovery is off by default and enabled only by configuration, not inferred from credentials. Turning on any fallback can add latency, provider calls, cost, and data-sharing scope.

## Route and Configuration Semantics

There is no default fallback route or hard-coded model chain.

- With no `GEMINI_MODELS`, an unpinned call invokes the canonical `GEMINI_MODEL` or compatibility-default model exactly once.
- One unique candidate in `GEMINI_MODELS` is still a one-candidate route and is invoked at most once. Multiple candidates are trimmed, deduplicated, and tried in declared order.
- A tool call with an explicit `modelname` is pinned to that model for one attempt. It skips route position and cooldown for the current call, never falls through to another Gemini model or provider, and does not change the configured route. A transient pinned failure can still cool that model for later unpinned calls.
- Structured HTTP 403 evidence and billing failures always fail fast. Billing, quota, exhausted, rate, retry, or allowlisted-looking body prose does not permit a later candidate or backup.
- Backup credentials alone do not enable backup. `GEMINI_BACKUP_ENABLED=true` is required, and all canonical OpenAI-compatible settings—including `OPENAI_COMPATIBLE_API_KEY`, `OPENAI_COMPATIBLE_BASE_URL`, `OPENAI_COMPATIBLE_MODEL`, and `ALLOWED_MEDIA_ROOTS`—must be complete. Any other switch value fails startup. Omission or `false` leaves backup disabled and ignores unused backup settings.

The recovery controls are:

| Variable | Default | Allowed values and behavior |
|---|---:|---|
| `GEMINI_MODELS` | No list | Comma-separated ordered Gemini candidates. Cannot be supplied with `GEMINI_MODEL`. |
| `GEMINI_MAX_ATTEMPTS` | `4` | Integer from `1` through `8`; shared by started Gemini and backup invocations. |
| `GEMINI_RECOVERY_DEADLINE_SECONDS` | `30` | Integer from `1` through `120`; soft deadline for starting recovery work after preparation. |
| `GEMINI_BASE_BACKOFF_MS` | `250` | Integer from `0` through `5000`. |
| `GEMINI_MAX_BACKOFF_MS` | `2000` | Integer from `0` through `10000`, not less than the base backoff. |
| `GEMINI_COOLDOWN_SECONDS` | `60` | Integer from `0` through `600`. |
| `GEMINI_BACKUP_ENABLED` | `false` | Exact `true` enables a completely configured final backup; exact `false` disables it. |

Bad recovery values stop startup. They are not clamped, rounded, coerced, or replaced with defaults.

## Attempts, Deadlines, and Backoff

Media validation, preparation, upload, and Gemini video processing happen before recovery starts and keep their independent timeout (300s).

Only started provider invocations count as attempts. Total Gemini request invocations cannot exceed `GEMINI_MAX_ATTEMPTS`.

Once started, a request keeps the adapter's independent timeout (60 seconds by default, at most 120 seconds for the OpenAI-compatible adapter). A success arriving after the recovery deadline is accepted, but does not count as a valid tool result.

Eligible transitions use capped exponential backoff. A valid adapter-normalized `retryAfterMs` replaces normal backoff but is still capped by `GEMINI_MAX_BACKOFF_MS`.

## Conservative HTTP 429 Policy

Every exact structured HTTP 429 evidence is treated as transient under the unchanged allowlist. Routing does not infer a quota subtype—RPM, TPM, daily/RPD, spend, project/shared, or any other—from provider prose, uncharacterized SDK fields, or arbitrary JSON.

Gemini candidates can share project quota. Daily, spend, project/shared, or other long-window exhaustion can therefore consume later configured Gemini attempts without recovering. The wasted cost is bounded by the attempt cap and the recovery start deadline. This is a deliberate conservative false positive: bounded attempts are preferred over routing decisions inferred from provider prose.

Re-run the SDK characterization and request-count gate whenever the resolved `@google/genai` version or dependency resolution changes, including a later resolution within the declared version range. One router attempt must remain one upstream request. If a later SDK silently retries, disable those retries or count every underlying request within the same `GEMINI_MAX_ATTEMPTS` cap before the change can pass verification.

## Process-Local Cooldown

Transient Gemini and transient backup failures share the same in-memory cooldown, keyed by provider and model. It is shared across requests and callers in one process, so one caller's transient failure can make a later unpinned call skip that candidate. Pins bypass cooldown for their current attempt but can create or refresh cooldown for later unpinned calls.

The cooldown is capped at 64 entries, expires lazily, never polls, and is discarded on process restart. When full, the earliest-expiring entry is evicted, with insertion order breaking equal-expiry ties. Separate processes or instances do not share state. An all-cooling route terminates immediately, or considers the explicitly enabled backup within the remaining budget; it never waits for capacity.

## Optional Final Backup

The OpenAI-compatible backup is an explicitly enabled, optional, last-resort path—not a recovery guarantee. It runs at most once, only after every Gemini candidate transiently failed or was skipped for an active cooldown, no fail-fast condition occurred, no `modelname` pin was supplied, and attempt/deadline budget remains.

The operator must select a backup model that supports the requested image, audio, or video kind. The server has no capability registry, performs no capability probe, silently substitutes no model, and never forwards or translates a Gemini pin to backup. Unsupported media fails fast under the backup adapter's normalized category.

Backup may be unavailable, reject the modality, share exhausted project or long-window limits, or fail under its own quota or timeout. It adds latency and cost, and may send the prompt and media to another endpoint with different privacy, retention, residency, and billing terms. Review those terms and the configured `ALLOWED_MEDIA_ROOTS` before enabling it.

Backup is always the final attempt. Authentication, permission, HTTP 403, billing, unsupported-media, safety, invalid-request, malformed-response, and unknown backup failures are all final: no second backup, provider, or delay follows. A transient backup failure also creates process-local cooldown, which can suppress backup on later requests in that process.

## Rollback

For immediate operational rollback, set `GEMINI_BACKUP_ENABLED=false`, remove `GEMINI_MODELS` and the other recovery settings, and restart all instances. This returns unpinned Gemini calls to the canonical one-model, one-attempt behavior. Disabling recovery does not revoke any credential.

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