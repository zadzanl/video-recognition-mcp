# Configuration Reference

Variable names and provider values are case-sensitive. Leading and trailing spaces are trimmed before values are read. Credentials never pick the provider for you.

## Provider Selection and Common Variables

| Variable | Required | Default | Rules |
|---|---:|---|---|
| `RECOGNITION_PROVIDER` | No | `gemini` | Must be `gemini` or `openai-compatible`. Leave unset to use Gemini. |
| `TRANSPORT_TYPE` | No | `stdio` | `sse` selects SSE; anything else uses stdio. |
| `PORT` | No | `3000` when SSE starts with no port set | Used by SSE transport. |
| `LOG_LEVEL` | No | `fatal` | One of `verbose`, `debug`, `info`, `warn`, `error`, or `fatal`. |

Only the selected provider's variables are checked. Bad values for the unselected provider are ignored. Both credential sets can be present, but `RECOGNITION_PROVIDER` still decides which one is used.

## Gemini Variables

| Variable | Required | Default | Rules |
|---|---:|---|---|
| `GOOGLE_API_KEY` | When Gemini is selected | None | Must be non-empty after trimming. |
| `GEMINI_MODEL` | No | `gemini-2.0-flash` | One model name, up to 200 Unicode characters. |
| `GEMINI_MODEL_ALLOWLIST` | No | Unrestricted | Comma-separated exact model names. |

Gemini keeps its upload/cache processing path and its up-to-300-second video wait; that wait can end in `GEMINI_VIDEO_PROCESSING_TIMEOUT`. Cut and chunk long videos to stay under it. `GEMINI_MODELS` is reserved for the opt-in recovery route and cannot be combined with `GEMINI_MODEL`.

## Gemini Recovery and Fallback

Gemini model recovery and the final OpenAI-compatible backup are opt-in. See the [Provider Recovery Reference](RECOVERY.md) for route setup, attempt and deadline behavior, backoff and process-local cooldown, cost and privacy notes, rollback order, and backup credential incidents.

### Gemini Recovery Example

Set `GEMINI_MODELS` to a comma-separated list of Gemini models to try in order. The server starts with the first model and falls through to the next one when it gets a retryable error (rate limit, server error, timeout). If you do not set `GEMINI_MODELS`, the server uses the single `GEMINI_MODEL` (or the default `gemini-2.0-flash`) with no fallback.

```json
{
  "mcpServers": {
    "video-recognition-gemini-recovery": {
      "command": "node",
      "args": [
        "/path/to/mcp-video-recognition/dist/index.js"
      ],
      "env": {
        "GOOGLE_API_KEY": "your_google_api_key",
        "GEMINI_MODELS": "gemini-2.5-flash, gemini-2.0-flash, gemini-2.0-flash-lite",
        "GEMINI_MAX_ATTEMPTS": "4",
        "GEMINI_COOLDOWN_SECONDS": "60",
        "LOG_LEVEL": "warn"
      },
      "disabled": false,
      "autoApprove": []
    }
  }
}
```

The example above tries `gemini-2.5-flash` first, then `gemini-2.0-flash`, then `gemini-2.0-flash-lite`. Each model gets at most one attempt, and the total across all models is capped by `GEMINI_MAX_ATTEMPTS`. A model that fails with a retryable error is skipped for `GEMINI_COOLDOWN_SECONDS` (60 seconds in this example).

You can also enable the optional OpenRouter backup by adding `GEMINI_BACKUP_ENABLED=true` plus the full OpenAI-compatible config (see the OpenRouter example below). The backup runs at most once, after every Gemini model has failed or is in cooldown.

See `mcp-json-example/gemini-recovery-example-MCP.json` for a ready-to-use VS Code MCP config file.

## Full Example (All Variables)

This example shows every supported variable in one place. The Gemini and OpenAI-compatible sections are alternatives selected by `RECOGNITION_PROVIDER`. Values shown are defaults or placeholders; adjust to your setup.

`GEMINI_MODEL` and `GEMINI_MODELS` cannot be combined (setting both fails startup), so the two variants are shown separately below. All other variables are common to both variants.

Variant A — single Gemini model (`GEMINI_MODEL`), no recovery route:

```json
{
  "mcpServers": {
    "video-recognition-full": {
      "command": "node",
      "args": [
        "/path/to/mcp-video-recognition/dist/index.js"
      ],
      "env": {
        "RECOGNITION_PROVIDER": "gemini",
        "TRANSPORT_TYPE": "stdio",
        "PORT": "3000",
        "LOG_LEVEL": "fatal",

        "GOOGLE_API_KEY": "your_google_api_key",
        "GEMINI_MODEL": "gemini-2.0-flash",
        "GEMINI_MODEL_ALLOWLIST": "gemini-2.0-flash, gemini-2.5-flash",

        "GEMINI_BACKUP_ENABLED": "false",

        "OPENAI_COMPATIBLE_API_KEY": "your_openrouter_api_key",
        "OPENAI_COMPATIBLE_BASE_URL": "https://openrouter.ai/api/v1",
        "OPENAI_COMPATIBLE_MODEL": "your_openrouter_model_id",
        "OPENAI_COMPATIBLE_PROVIDER_LABEL": "OpenRouter",
        "OPENAI_COMPATIBLE_MODEL_ALLOWLIST": "",
        "OPENAI_COMPATIBLE_REQUEST_TIMEOUT_SECONDS": "60",
        "OPENAI_COMPATIBLE_MAX_RESPONSE_BYTES": "1048576",
        "MAX_INLINE_MEDIA_BYTES": "20971520",
        "ALLOWED_MEDIA_ROOTS": "/operator-controlled/media",
        "ALLOW_INSECURE_LOCAL_OPENAI_COMPATIBLE": "false"
      },
      "disabled": false,
      "autoApprove": []
    }
  }
}
```

Variant B — Gemini recovery route (`GEMINI_MODELS`) with model fallback. Replace the `GEMINI_MODEL` line from Variant A with:

```json
        "GEMINI_MODELS": "gemini-2.5-flash, gemini-2.0-flash, gemini-2.0-flash-lite",
        "GEMINI_MAX_ATTEMPTS": "4",
        "GEMINI_RECOVERY_DEADLINE_SECONDS": "30",
        "GEMINI_BASE_BACKOFF_MS": "250",
        "GEMINI_MAX_BACKOFF_MS": "2000",
        "GEMINI_COOLDOWN_SECONDS": "60",
```

Notes on combining variables:

- `GEMINI_MODEL` and `GEMINI_MODELS` cannot be used together. Setting both fails startup.
- `GEMINI_BACKUP_ENABLED=true` requires the full OpenAI-compatible block including `ALLOWED_MEDIA_ROOTS`.
- `ALLOW_INSECURE_LOCAL_OPENAI_COMPATIBLE` only applies when `RECOGNITION_PROVIDER` is `openai-compatible`.
- Variables for the unselected provider are ignored (but both credential sets can be present).

## OpenAI-Compatible Variables

| Variable | Required | Default | Rules |
|---|---:|---|---|
| `OPENAI_COMPATIBLE_API_KEY` | Yes | None | Non-empty bearer credential. |
| `OPENAI_COMPATIBLE_BASE_URL` | Yes | None | Operator-controlled base URL; see the [Security Reference](SECURITY.md). |
| `OPENAI_COMPATIBLE_MODEL` | Yes | None | One model name, up to 200 Unicode characters. |
| `OPENAI_COMPATIBLE_PROVIDER_LABEL` | No | `OpenAI-compatible provider` | Up to 64 Unicode characters. |
| `OPENAI_COMPATIBLE_MODEL_ALLOWLIST` | No | Unrestricted | Comma-separated exact model names. |
| `OPENAI_COMPATIBLE_REQUEST_TIMEOUT_SECONDS` | No | `60` | Whole number from `1` through `120`. |
| `OPENAI_COMPATIBLE_MAX_RESPONSE_BYTES` | No | `1048576` | Whole number from `1024` through `4194304`. |
| `MAX_INLINE_MEDIA_BYTES` | No | `20971520` | Whole number from `1048576` through `104857600`. |
| `ALLOWED_MEDIA_ROOTS` | Yes | None | One or more existing operator-controlled directories, split by Node `path.delimiter`. |
| `ALLOW_INSECURE_LOCAL_OPENAI_COMPATIBLE` | No | Disabled | After trimming, exact `true` enables allowed loopback HTTP. Exact `false`, unset, or empty disables it. Any other non-empty value fails startup. |

Numeric values must match `^[0-9]+$`, be safe integers, and stay inside their inclusive ranges. Bad values stop startup; they are not clamped, rounded, coerced, or replaced with defaults.

When OpenAI-compatible is selected, any of these excluded aliases fails startup, even if empty: `MEDIA_ROOTS`, `OPENROUTER_API_KEY`, `OPENROUTER_MODELS`, or `OPENROUTER_RESPONSE_CACHE`.

## Model Allowlists

`GEMINI_MODEL_ALLOWLIST` and `OPENAI_COMPATIBLE_MODEL_ALLOWLIST` limit the models an MCP client may pick. Lists are split on commas, entries are trimmed, empty entries are dropped, and duplicates keep their first occurrence.

The effective model is the `modelname` argument when supplied, otherwise the provider's configured or default model. The allowlist is checked before file metadata, reads, encoding, uploads, or network access. A rejected model returns an `invalid-request: ProviderFailure`.

## OpenRouter Example

Use the generic OpenAI-compatible variables. Set the base URL to `https://openrouter.ai/api/v1/chat/completions`:

```json
{
  "mcpServers": {
    "video-recognition-openrouter": {
      "command": "node",
      "args": [
        "/path/to/mcp-video-recognition/dist/index.js"
      ],
      "env": {
        "RECOGNITION_PROVIDER": "openai-compatible",
        "OPENAI_COMPATIBLE_API_KEY": "your_openrouter_api_key",
        "OPENAI_COMPATIBLE_BASE_URL": "https://openrouter.ai/api/v1",
        "OPENAI_COMPATIBLE_MODEL": "your_openrouter_model_id",
        "OPENAI_COMPATIBLE_PROVIDER_LABEL": "OpenRouter",
        "ALLOWED_MEDIA_ROOTS": "/operator-controlled/media"
      },
      "disabled": false,
      "autoApprove": []
    }
  }
}
```

`ALLOWED_MEDIA_ROOTS` uses `;` on Windows and `:` on POSIX. For example, `C:\\media;D:\\approved-media` on Windows or `/srv/media:/opt/approved-media` on POSIX.

## Supported Media and Request Shapes

| Provider | Modality | Extensions and MIME types | OpenAI-compatible wire part |
|---|---|---|---|
| Gemini | Image | `.jpg`, `.jpeg` → `image/jpeg`; `.png` → `image/png`; `.webp` → `image/webp` | Not applicable |
| Gemini | Audio | `.wav` → `audio/wav`; `.mp3` → `audio/mp3`; `.ogg` → `audio/ogg` | Not applicable |
| Gemini | Video | `.mp4` → `video/mp4` | Not applicable |
| OpenAI-compatible | Image | `.jpg`, `.jpeg` → `image/jpeg`; `.png` → `image/png`; `.webp` → `image/webp` | `image_url` containing a data URL |
| OpenAI-compatible | Audio | `.wav` → `audio/wav`; `.mp3` → `audio/mp3` | `input_audio` containing raw base64 and format `wav` or `mp3` |
| OpenAI-compatible | Video | `.mp4` → `video/mp4`; `.mpeg` → `video/mpeg`; `.mov` → `video/mov`; `.webm` → `video/webm` | `video_url` containing a data URL |

GIF and AVI are unsupported and rejected before any network activity. OpenAI-compatible files larger than `MAX_INLINE_MEDIA_BYTES` are rejected before reading or base64 allocation. The inline size setting applies only to the OpenAI-compatible adapter; Gemini keeps its default API behavior.

The `video_url` content part is an **OpenRouter extension** and does not work on every OpenAI-compatible endpoint. Confirm that your endpoint and model support it. Audio uses raw base64, not a data URL, and sends only the `wav` or `mp3` format value.

For OpenAI-compatible operation, the requested path must resolve to a regular file inside one of the allowed roots. Traversal and symlink, junction, or reparse-point escapes are rejected. Links that canonicalize inside an allowed root are accepted.
