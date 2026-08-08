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
