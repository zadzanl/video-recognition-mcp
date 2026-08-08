<!--
status: active
phase: phase-6-documentation-and-verification
sprint: provider-foundation-first-sprint
last_modified: 2026-08-06
agent_notes: "Documents selectable Gemini and OpenAI-compatible providers and operator security boundaries."
insights: "Manual AbortController/setTimeout composition sets the Node floor at 18.0.0; OpenRouter video_url is not portable across arbitrary OpenAI-compatible endpoints."
-->

# MCP Video Recognition Server

An MCP (Model Context Protocol) server that provides tools for image, audio, and video recognition using either Google Gemini or an explicitly configured OpenAI-compatible endpoint.

<a href="https://glama.ai/mcp/servers/@mario-andreschak/mcp_video_recognition">
  <img width="380" height="200" src="https://glama.ai/mcp/servers/@mario-andreschak/mcp_video_recognition/badge" alt="Video Recognition Server MCP server" />
</a>

## Features

- **Selectable provider**: Google Gemini by default, or an explicitly selected OpenAI-compatible endpoint
- **Image Recognition**: Analyze and describe supported local images
- **Audio Recognition**: Analyze and transcribe supported local audio
- **Video Recognition**: Analyze and describe supported local video
- **OpenRouter configuration**: OpenRouter is the documented OpenAI-compatible configuration

Model capabilities vary. Selecting the OpenAI-compatible provider does not mean every endpoint or model supports every media tool. The server does not substitute a model or provider when a requested modality is unsupported.

## Prerequisites

- Node.js **18.0.0 or later**. The adapter manually composes cancellation and timeout with `AbortController`, event listeners, and `setTimeout`; it does not use `AbortSignal.any(...)`. An `AbortSignal.any(...)` implementation would require Node.js 18.17.0 or later.
- Credentials for the selected provider:
  - Gemini: `GOOGLE_API_KEY`
  - OpenAI-compatible: `OPENAI_COMPATIBLE_API_KEY`

## Installation

### Manual Installation

1. Clone the repository:
   ```bash
   git clone https://github.com/yourusername/mcp-video-recognition.git
   cd mcp-video-recognition
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

3. Build the project:
   ```bash
   npm run build
   ```

### Installing in [FLUJO](https://github.com/mario-andreschak/FLUJO/)

1. Click Add Server.
2. Copy and paste the GitHub URL into FLUJO.
3. Click Parse, Clone, Install, Build and Save.

### Installing via Configuration Files

To integrate this MCP server with Cline or another MCP client through a configuration file:

1. Open the client's MCP settings.
2. Add the server to the `mcpServers` object:

   ```json
   {
     "mcpServers": {
       "video-recognition": {
         "command": "node",
         "args": [
           "/path/to/mcp-video-recognition/dist/index.js"
         ],
         "env": {
           "GOOGLE_API_KEY": "your_google_api_key"
         },
         "disabled": false,
         "autoApprove": []
       }
     }
   }
   ```

3. Replace `/path/to/mcp-video-recognition/dist/index.js` with the built `dist/index.js` path. Use forward slashes or doubled backslashes (`\\`) on Windows.
4. Save the settings file and reconnect the MCP client if necessary.

## Configuration

Environment variable names and provider values are case-sensitive. Leading and trailing ASCII whitespace is trimmed before values are interpreted. Credentials never infer provider selection.

### Provider Selection and Common Variables

| Variable | Required | Default | Rules |
|---|---:|---|---|
| `RECOGNITION_PROVIDER` | No | `gemini` | Accepts exactly `gemini` or `openai-compatible`. Omission selects Gemini. |
| `TRANSPORT_TYPE` | No | `stdio` | `sse` selects SSE; all other values use stdio. |
| `PORT` | No | `3000` when the SSE server starts without a configured port | Used by SSE transport. |
| `LOG_LEVEL` | No | `fatal` | Supported values are `verbose`, `debug`, `info`, `warn`, `error`, and `fatal`. |

Only variables for the selected provider are parsed and validated. Malformed variables belonging only to the unselected provider have no effect. Both credential sets may be present, but selection still follows `RECOGNITION_PROVIDER` and defaults to Gemini.

### Gemini Variables

| Variable | Required | Default | Rules |
|---|---:|---|---|
| `GOOGLE_API_KEY` | When Gemini is selected | None | Must be non-empty after ASCII trimming. |
| `GEMINI_MODEL` | No | `gemini-2.0-flash` | One model identifier, at most 200 Unicode scalar values. |
| `GEMINI_MODEL_ALLOWLIST` | No | Unrestricted | Comma-separated exact model identifiers. |

Gemini preserves its existing upload/cache processing path and its 300000 ms video-processing wait; the resulting timeout failure code is `GEMINI_VIDEO_PROCESSING_TIMEOUT`. This is not an environment variable. Gemini has no adapter-wide request deadline. The selected Gemini configuration fails startup if the deprecated alias `GEMINI_MODELS` is present, including when it is empty.

### OpenAI-Compatible Variables

| Variable | Required | Default | Rules |
|---|---:|---|---|
| `OPENAI_COMPATIBLE_API_KEY` | Yes | None | Non-empty bearer credential. |
| `OPENAI_COMPATIBLE_BASE_URL` | Yes | None | Operator-controlled base URL; rules are described below. |
| `OPENAI_COMPATIBLE_MODEL` | Yes | None | One model identifier, at most 200 Unicode scalar values. |
| `OPENAI_COMPATIBLE_PROVIDER_LABEL` | No | `OpenAI-compatible provider` | At most 64 Unicode scalar values. |
| `OPENAI_COMPATIBLE_MODEL_ALLOWLIST` | No | Unrestricted | Comma-separated exact model identifiers. |
| `OPENAI_COMPATIBLE_REQUEST_TIMEOUT_SECONDS` | No | `60` | Decimal integer from `1` through `120`, inclusive. |
| `OPENAI_COMPATIBLE_MAX_RESPONSE_BYTES` | No | `1048576` | Decimal integer from `1024` through `4194304`, inclusive. |
| `MAX_INLINE_MEDIA_BYTES` | No | `20971520` | Decimal integer from `1048576` through `104857600`, inclusive. |
| `ALLOWED_MEDIA_ROOTS` | Yes | None | One or more existing operator-controlled directories, split by Node `path.delimiter`. |
| `ALLOW_INSECURE_LOCAL_OPENAI_COMPATIBLE` | No | Disabled | After ASCII trimming, exact `true` enables allowed loopback HTTP; exact `false`, unset, or empty disables it. Other non-empty values fail startup. |

Configured numeric values must match `^[0-9]+$`, be safe integers, and fall inside their inclusive ranges. Invalid values fail startup; they are not clamped, rounded, truncated, coerced, or replaced with defaults.

When OpenAI-compatible is selected, the presence of any excluded alias fails startup, including an empty value: `MEDIA_ROOTS`, `OPENROUTER_API_KEY`, `OPENROUTER_MODELS`, or `OPENROUTER_RESPONSE_CACHE`.

### Model Allowlists

`GEMINI_MODEL_ALLOWLIST` and `OPENAI_COMPATIBLE_MODEL_ALLOWLIST` limit the models that clients may select. Lists are split on commas, entries are ASCII-trimmed, empty entries are dropped, comparison is case-sensitive and exact, and duplicate entries retain their first occurrence. A present list with no non-empty entries fails startup.

The effective model is the per-call `modelname` override when supplied, otherwise the selected provider's configured/default model. Allowlist enforcement occurs before file metadata, file reads, encoding, uploads, or network access. A rejected model produces a `ProviderFailure` in category `invalid-request` with exactly this safe message, without echoing model names:

```text
Requested model is not allowed.
```

### OpenRouter Example

Use the generic OpenAI-compatible variables; excluded `OPENROUTER_*` aliases are not accepted. The base URL below becomes `https://openrouter.ai/api/v1/chat/completions`:

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

`ALLOWED_MEDIA_ROOTS` uses `;` on Windows and `:` on POSIX. For example, use `C:\\media;D:\\approved-media` on Windows or `/srv/media:/opt/approved-media` on POSIX.

## Supported Media and Request Shapes

| Provider | Modality | Extensions and MIME types | OpenAI-compatible wire part |
|---|---|---|---|
| Gemini | Image | `.jpg`, `.jpeg` → `image/jpeg`; `.png` → `image/png`; `.webp` → `image/webp` | Not applicable |
| Gemini | Audio | `.wav` → `audio/wav`; `.mp3` → `audio/mp3`; `.ogg` → `audio/ogg` | Not applicable |
| Gemini | Video | `.mp4` → `video/mp4` | Not applicable |
| OpenAI-compatible | Image | `.jpg`, `.jpeg` → `image/jpeg`; `.png` → `image/png`; `.webp` → `image/webp` | `image_url` containing a data URL |
| OpenAI-compatible | Audio | `.wav` → `audio/wav`; `.mp3` → `audio/mp3` | `input_audio` containing raw base64 and format `wav` or `mp3` |
| OpenAI-compatible | Video | `.mp4` → `video/mp4`; `.mpeg` → `video/mpeg`; `.mov` → `video/mov`; `.webm` → `video/webm` | `video_url` containing a data URL |

GIF and AVI are unsupported and are rejected before network activity. OpenAI-compatible files larger than `MAX_INLINE_MEDIA_BYTES` are rejected before file reading/base64 allocation. The inline size setting applies to the OpenAI-compatible adapter; Gemini retains its existing upload-based behavior.

The `video_url` content part is an **OpenRouter extension** and is not portable to arbitrary OpenAI-compatible endpoints. Confirm that the selected endpoint and model support the requested modality. Audio uses raw base64, not a data URL, and includes only the `wav` or `mp3` format value.

For OpenAI-compatible operation, every configured root is canonicalized and must be an existing directory controlled by the operator. The requested path must resolve to a regular file within at least one canonical root. Traversal and symlink, junction, or reparse-point escapes are rejected before file read or network access. Containment is separator-aware and case-insensitive on Windows. Links that canonicalize inside an allowed root are accepted. Concurrent filesystem changes are outside the threat model; the adapter does not lock file descriptors.

## Security

### Endpoint and Transport Rules

- HTTPS is required by default.
- Cleartext HTTP is allowed only when `ALLOW_INSECURE_LOCAL_OPENAI_COMPATIBLE` is ASCII-trimmed to exact `true` and the URL host is exactly `localhost`, `127.0.0.1`, or `[::1]` (parsed as `::1`). For example, `" true "` enables the option after trimming. `localhost.`, `127/8`, IPv4-mapped IPv6, other IPv6 addresses, and DNS names do not qualify.
- Loopback HTTP sends credentials and media in cleartext on the local network stack. Enable it only for a trusted local endpoint and disable it when no longer needed.
- The base URL may use only HTTPS, or the explicitly enabled loopback HTTP exception. After standard edge trimming, it must contain no control characters or whitespace and must not contain URL user-info, query, or fragment components.
- Trailing path slashes are removed and one `/chat/completions` suffix is appended. A configured path already ending in the case-sensitive suffix `/chat/completions` fails startup.
- The endpoint origin is operator configuration and cannot be overridden by tool callers.
- Requests use `redirect: 'manual'`; every 3xx response is rejected rather than followed, preventing credentials and media from being forwarded to another location.

### Resource and Diagnostic Bounds

- The OpenAI-compatible HTTP timer covers fetch, response headers, and bounded response-body reading. It does not include local path validation, file reading, or base64 encoding.
- Responses are incrementally read up to `OPENAI_COMPATIBLE_MAX_RESPONSE_BYTES`. Exceeding the cap stops reading and returns a bounded `malformed-response` failure.
- Inline media is bounded by `MAX_INLINE_MEDIA_BYTES` before read/base64 allocation.
- Model identifiers are limited to 200 Unicode scalar values and provider labels to 64. Both reject C0 controls, DEL, U+2028, and U+2029.
- Provider `safeMessage` strings are fixed, line-separator-free, and below 4 KiB. This is not a general escaping or 4 KiB cap for logger output or non-provider errors. `LOG_LEVEL` defaults to `fatal`; use higher log levels only in a controlled environment. Raw credentials, authorization headers, response bodies, prompts, paths, data URLs, and encoded media are not exposed through `ProviderFailure` safe messages.

### Credentials and Incident Response

Keep provider credentials in the MCP process environment or an appropriate secret manager; do not place real keys in source control. If a credential or endpoint may be compromised:

1. Disable the affected provider selection or stop the affected server instances.
2. Revoke the exposed key at the provider.
3. Rotate replacement credentials.
4. Remove stale secrets from MCP client configuration, deployment configuration, and secret stores.
5. Restart every affected server instance with the replacement configuration.
6. Inspect the server's bounded diagnostics for relevant failure categories and timing without copying secrets or media into incident records.

Operators own the `ALLOWED_MEDIA_ROOTS` boundary. Configure only narrow, operator-controlled directories; do not use broad user, temporary, filesystem-root, or attacker-writable directories.

### Attempt and Cancellation Semantics

Each tool call makes at most one provider recognition attempt. There is no application-level retry, fallback, cooldown, parallel inference, provider substitution, or model substitution. `Retry-After` is diagnostic only and never triggers a retry.

For OpenAI-compatible calls, caller abort maps to `cancelled` / `CALLER_CANCELLED`; expiration of the adapter's private timer maps to `timeout` / `ADAPTER_TIMEOUT`. Gemini keeps its 300000 ms video-processing wait, which maps to `timeout` / `GEMINI_VIDEO_PROCESSING_TIMEOUT`, and has no adapter-wide deadline.

## Usage

### Starting the Server

#### With Gemini and stdio Transport (Default)

```bash
GOOGLE_API_KEY=your_api_key npm start
```

#### With Gemini and SSE Transport

```bash
GOOGLE_API_KEY=your_api_key TRANSPORT_TYPE=sse PORT=3000 npm start
```

#### With OpenAI-Compatible Provider

```bash
RECOGNITION_PROVIDER=openai-compatible \
OPENAI_COMPATIBLE_API_KEY=your_api_key \
OPENAI_COMPATIBLE_BASE_URL=https://openrouter.ai/api/v1 \
OPENAI_COMPATIBLE_MODEL=your_model_id \
ALLOWED_MEDIA_ROOTS=/operator-controlled/media \
npm start
```

On Windows PowerShell, set the same values through `$env:VARIABLE = 'value'` before running `npm start`.

### Using the Tools

The server provides three MCP tools:

#### Image Recognition

```json
{
  "name": "image_recognition",
  "arguments": {
    "filepath": "/path/to/image.jpg",
    "prompt": "Describe this image in detail",
    "modelname": "provider-model-id"
  }
}
```

#### Audio Recognition

```json
{
  "name": "audio_recognition",
  "arguments": {
    "filepath": "/path/to/audio.mp3",
    "prompt": "Transcribe this audio"
  }
}
```

#### Video Recognition

```json
{
  "name": "video_recognition",
  "arguments": {
    "filepath": "/path/to/video.mp4",
    "prompt": "Describe what happens in this video"
  }
}
```

### Tool Parameters

All three tools accept:

- `filepath` (required): Path to the local media file.
- `prompt` (optional): Recognition prompt. The schema default `Describe this content` is the sole prompt default.
- `modelname` (optional): Per-call model override forwarded unchanged to the selected provider. When omitted, the tool forwards `undefined` and the provider applies its configured/default model.

## Development

### Running in Development Mode

```bash
GOOGLE_API_KEY=your_api_key npm run dev
```

### Verification

Build and run the provider foundation test suites:

```bash
npm run verify:provider-foundation
```

### Project Structure

- `src/index.ts`: Entry point and selected-provider construction
- `src/server.ts`: MCP server and transport implementation
- `src/tools/`: Provider-neutral tool implementations
- `src/services/`: Gemini and OpenAI-compatible provider implementations
- `src/types/`: Shared type definitions
- `src/utils/`: Utility functions

## License

MIT
