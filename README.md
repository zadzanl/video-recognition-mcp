# MCP Video Recognition Server

An MCP (Model Context Protocol) server that provides tools for image, audio, and video recognition. It supports Google Gemini by default and can use a configurable OpenAI-compatible provider for image, video, and audio recognition (the provider/model must support the requested media modality), such as OpenRouter or Xiaomi MiMo's OpenAI-compatible endpoint.

<a href="https://glama.ai/mcp/servers/@mario-andreschak/mcp_video_recognition">
  <img width="380" height="200" src="https://glama.ai/mcp/servers/@mario-andreschak/mcp_video_recognition/badge" alt="Video Recognition Server MCP server" />
</a>

## Features

- **Image Recognition**: Analyze and describe images using Google Gemini or a configured OpenAI-compatible provider
- **Audio Recognition**: Analyze and transcribe audio using Google Gemini (.mp3, .wav, .ogg) or a configured OpenAI-compatible provider (.wav, .mp3)
- **Video Recognition**: Analyze and describe videos using Google Gemini or a configured OpenAI-compatible provider
- **Config-only provider/model selection**: MCP tools expose only `filepath` and `prompt`; provider and model are deployment configuration

## Prerequisites

- Node.js 18 or higher
- Google Gemini API key for Gemini mode, or OpenAI-compatible API key/base URL/model for OpenAI-compatible mode

## Installation

### Manual Installation

1. Clone the repository:
   ```bash
   git clone https://github.com/mario-andreschak/mcp_video_recognition.git
   cd mcp_video_recognition
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

1. Click Add Server
2. Copy & Paste Github URL into FLUJO
3. Click Parse, Clone, Install, Build and Save.

### Installing via Configuration Files

#### VSCode-style  MCP Configuration Example

```json
{
  "inputs": [
    {
      "id": "openrouter-api-key",
      "type": "promptString",
      "description": "OpenRouter API key",
      "password": true
    }
  ],
  "servers": {
    "video-recognition": {
      "type": "stdio",
      "command": "node",
      "args": [
        "C:/Projects/robot-thingy/video-recognition-mcp/dist/index.js"
      ],
      "env": {
        "RECOGNITION_PROVIDER": "openai-compatible",
        "OPENAI_COMPATIBLE_API_KEY": "${input:openrouter-api-key}",
        "OPENAI_COMPATIBLE_BASE_URL": "https://openrouter.ai/api/v1",
        "OPENAI_COMPATIBLE_MODEL": "xiaomi/mimo-v2.5",
        "OPENAI_COMPATIBLE_PROVIDER_LABEL": "OpenRouter"
      }
    }
  }
}
```

Build the project before starting the MCP server so `dist/index.js` exists. If you change provider code or rebuild the server, restart the MCP server/client session so VS Code reloads the updated `dist/` files.

## Configuration

The server is configured using environment variables. Provider/model selection is server-side configuration only; MCP tool calls do not accept `provider` or `modelname`.

### Provider Selection

| Variable | Description |
|----------|-------------|
| `RECOGNITION_PROVIDER` | Optional. Supported values: `gemini` or `openai-compatible`. Explicit selection wins. |
| `GOOGLE_API_KEY` | Gemini API key. Required when provider resolution selects Gemini. All fallback attempts share the same key and project quota pool. |
| `GEMINI_MODEL` | Optional single Gemini model. Disables fallback — only one model is tried. Do not set with `GEMINI_MODELS`. |
| `GEMINI_MODELS` | Optional comma-separated ordered list of Gemini model IDs for fallback. Duplicate IDs are removed (first occurrence kept). Do not set with `GEMINI_MODEL`. |
| `OPENAI_COMPATIBLE_API_KEY` | API key for the configured OpenAI-compatible endpoint. Required in OpenAI-compatible mode. |
| `OPENAI_COMPATIBLE_BASE_URL` | Base URL for the OpenAI-compatible API, without `/chat/completions`; for example `https://openrouter.ai/api/v1`. |
| `OPENAI_COMPATIBLE_MODEL` | Provider-specific model ID; for example `xiaomi/mimo-v2.5` on OpenRouter or `mimo-v2.5` on Xiaomi MiMo's direct endpoint. |
| `OPENAI_COMPATIBLE_PROVIDER_LABEL` | Optional human-readable provider label used in tool descriptions; for example `OpenRouter`. |
| `MAX_INLINE_MEDIA_BYTES` | Optional maximum local file size for OpenAI-compatible base64 request bodies. Defaults to `20971520` bytes (20 MiB). |
| `OPENROUTER_API_KEY` | Optional. API key for OpenRouter to enable cross-provider failover routing when Google Gemini rate limits are hit. |
| `OPENROUTER_MODELS` | Optional comma-separated list of models to use on OpenRouter fallback (default: `google/gemini-2.5-flash,google/gemini-2.5-pro,openai/gpt-4o-mini`). |
| `MIMO_API_KEY` | Optional. API key for Xiaomi MiMo to enable cross-provider failover routing when Gemini and OpenRouter are exhausted. |
| `MIMO_MODELS` | Optional comma-separated list of models to use on MiMo fallback (default: `mimo-v2.5`). |
| `MIMO_BASE_URL` | Optional. Base URL for MiMo API (default: `https://api.xiaomimimo.com/v1`). |
| `RATE_LIMIT_MAX_WAIT_MS` | Optional. Maximum time (in milliseconds) the throttling queue will sleep and wait for rate-limiting slots before returning a timeout (default: `30000`). |

Provider resolution is intentionally conservative:

- If `RECOGNITION_PROVIDER` is set, that provider is used and only that provider's required credentials are validated.
- If `RECOGNITION_PROVIDER` is omitted and only `GOOGLE_API_KEY` is configured, Gemini is used.
- If `RECOGNITION_PROVIDER` is omitted, `GOOGLE_API_KEY` is absent, and a complete OpenAI-compatible config is present, OpenAI-compatible mode is used.
- If both Gemini and OpenAI-compatible config are present and `RECOGNITION_PROVIDER` is omitted, startup fails and asks you to set `RECOGNITION_PROVIDER` explicitly.

### Gemini Model Fallback

When Gemini mode is selected, the server can try multiple models in sequence until one succeeds. This is useful for working around model-specific rate limits, regional availability issues, or quota exhaustion.

**Default chain (no override):**
`gemini-3.5-flash` → `gemini-3-flash-preview` → `gemini-2.5-flash` → `gemini-3.1-flash-lite`

All attempts use the same `GOOGLE_API_KEY` and the same Google Cloud project quota pool.

**Single-model override (`GEMINI_MODEL`):**
```bash
GEMINI_MODEL=gemini-3.5-flash GOOGLE_API_KEY=your_api_key npm start
```
Only the specified model is tried. Multi-model fallback is disabled.

**Ordered list override (`GEMINI_MODELS`):**
```bash
GEMINI_MODELS=gemini-3.5-flash,gemini-2.5-flash GOOGLE_API_KEY=your_api_key npm start
```
Duplicates are removed while preserving first-occurrence order. An empty list after parsing fails startup.

**Conflict:**
Setting **both** `GEMINI_MODEL` and `GEMINI_MODELS` fails startup with an ambiguity error. Use one or the other.

**Tool descriptions** display the effective model configuration — a single model name when no fallback is configured, or `primary + N fallback model(s)` when a fallback chain is in use.

### Rate Limiting, Auto Recovery, and Cross-Provider Fallback

To handle rate limits and transient availability issues under high concurrency (e.g., parallel tool calls from a client), the server implements:
- **Auto Recovery**: The server manages rate limits on the tool side. Instead of failing the tool call when a model hits a rate limit, the request is either re-routed to another model (e.g., `gemini-3.5-flash` → `gemini-3-flash-preview`) or queued/throttled internally (sleeping and polling), meaning the call may take longer to complete but will succeed.
- **File-Backed Rate Limit Tracker**: A persistent JSON state file (`mcp-video-recognition-rate-limits.json` in the system temp directory) tracks active request counts and model cooldown states across server worker processes and restarts.
- **Human-Editable Limits File**: Configure request and token limits in `config/throttling-limits.json`. The keys define short/long durations, request caps, and token limits:
  * `Short_limit_duration_in_seconds`
  * `Long_limit_duration_in_seconds`
  * `Short_limit_request_cap`
  * `Long_limit_request_cap`
  * `Short_limit_token_cap`
  * `Long_limit_token_cap`
- **Cross-Provider Failover**: If all Google Gemini models fail or are cooling down, the server will route to OpenRouter models (if `OPENROUTER_API_KEY` is set), then MiMo models (if `MIMO_API_KEY` is set).
- **Strict Error Isolation**: Only rate-limiting/quota errors (such as 429, resource exhausted, or rate-limit-induced billing/precondition issues) and transient server errors (500/503) trigger model or provider fallback. Real authentication failures (401), invalid arguments, malformed prompts, and file upload/processing failures fail fast immediately.
- **API Key Secrecy**: No API keys or credentials are ever written to the persistent tracker state file, recorded in logs, or exposed in error messages.

### Gemini Mode

```bash
GOOGLE_API_KEY=your_api_key npm start
```

Optional explicit provider selection:

```bash
RECOGNITION_PROVIDER=gemini GOOGLE_API_KEY=your_api_key npm start
```

### OpenAI-Compatible Mode

OpenAI-compatible mode sends local image/video files as base64 data URLs and audio files as raw base64 `input_audio` content parts in chat completion request bodies. The selected model must support `input_audio` content parts; audio is limited to `.wav` and `.mp3` formats.

OpenRouter example:

```bash
RECOGNITION_PROVIDER=openai-compatible \
OPENAI_COMPATIBLE_API_KEY=your_openrouter_api_key \
OPENAI_COMPATIBLE_BASE_URL=https://openrouter.ai/api/v1 \
OPENAI_COMPATIBLE_MODEL=xiaomi/mimo-v2.5 \
OPENAI_COMPATIBLE_PROVIDER_LABEL=OpenRouter \
npm start
```

Direct Xiaomi MiMo OpenAI-compatible endpoint example:

```bash
RECOGNITION_PROVIDER=openai-compatible \
OPENAI_COMPATIBLE_API_KEY=your_xiaomi_mimo_api_key \
OPENAI_COMPATIBLE_BASE_URL=https://api.xiaomimimo.com/v1 \
OPENAI_COMPATIBLE_MODEL=mimo-v2.5 \
OPENAI_COMPATIBLE_PROVIDER_LABEL="Xiaomi MiMo OpenAI-compatible API" \
npm start
```

As of 2026-06-18, OpenRouter lists `xiaomi/mimo-v2.5` and describes it as native omnimodal with image/video understanding. Model availability and media support can change; if a provider rejects the selected model/media combination, the tool returns the upstream provider error.

### Transport and Logging

- `TRANSPORT_TYPE`: Transport type to use (`stdio` or `sse`, defaults to `stdio`). When set to `sse`, the server starts an Express HTTP server using the MCP SDK's Streamable HTTP transport at `http://localhost:{PORT}/mcp`. This endpoint handles:
  - `GET /mcp` — establishes a new SSE session (returns session ID via `Mcp-Session-Id` header)
  - `POST /mcp` — client-to-server JSON-RPC messages (requires `Mcp-Session-Id` header)
  - `DELETE /mcp` — terminates a session
  - **No authentication is built in.** Anyone who can reach the port can use the server.
- `PORT`: Port number for Streamable HTTP transport (defaults to `3000`)
- `LOG_LEVEL`: Logging level (`verbose`, `debug`, `info`, `warn`, `error`, `fatal`). **Defaults to `fatal`** — only fatal errors are logged unless you lower this.

## Usage

### Starting the Server

#### With stdio Transport (Default)

```bash
GOOGLE_API_KEY=your_api_key npm start
```

#### With Streamable HTTP Transport (selected by `TRANSPORT_TYPE=sse`)

```bash
GOOGLE_API_KEY=your_api_key TRANSPORT_TYPE=sse PORT=3000 npm start
```

### Using the Tools

The server provides three tools that can be called by MCP clients. Tool descriptions include the configured provider label and model.

#### Image Recognition

```json
{
  "name": "image_recognition",
  "arguments": {
    "filepath": "/path/to/image.jpg",
    "prompt": "Describe this image in detail"
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

All tools accept the following parameters:

- `filepath` (required): Path to the media file to analyze
- `prompt` (optional): Custom prompt for the recognition. The shared input schema default is `"Describe this content"`. Each tool callback also contains a fallback prompt (`"Describe this image"`, `"Describe this audio"`, `"Describe this video"`) if a falsy prompt reaches it.

Provider and model are not tool parameters. Configure them with environment variables before starting the server. Legacy clients that send extra fields such as `modelname` are not advertised by the schema; the current non-strict schema ignores unknown keys rather than honoring them.

### Supported File Formats

| Provider | Tool | Extensions | Notes |
|----------|------|------------|-------|
| Gemini | `image_recognition` | `.jpg`, `.jpeg`, `.png`, `.webp` | Uploaded to Google Gemini. |
| Gemini | `audio_recognition` | `.mp3`, `.wav`, `.ogg` | Uploaded to Google Gemini. |
| Gemini | `video_recognition` | `.mp4` | Preserves the current effective Gemini upload support set. |
| OpenAI-compatible | `image_recognition` | `.jpg`, `.jpeg`, `.png`, `.webp` | Sent as a base64 `image_url` data URL. |
| OpenAI-compatible | `video_recognition` | `.mp4`, `.mpeg`, `.mov`, `.avi`, `.webm` | Sent as a base64 `video_url` data URL; selected model must support video input. |
| OpenAI-compatible | `audio_recognition` | `.wav`, `.mp3` | Sent as an `input_audio` content part with raw base64 data and format metadata. Selected model must support `input_audio`. |

### Caching

In Gemini mode, the server uses an **in-memory MD5 cache** to avoid re-uploading files to Google. When a file is uploaded:

1. An MD5 checksum of the file content is computed.
2. If the checksum is already in the cache and the entry is less than **24 hours** old, the cached Gemini file reference is reused (no upload).
3. Otherwise the file is uploaded to Google Gemini and the cache is updated.

The cache lives in process memory only — it is lost on server restart. OpenAI-compatible mode does not cache base64 request bodies.

## Development

### Available Scripts

| Script | Command | Description |
|--------|---------|-------------|
| `build` | `tsc` | Compile TypeScript to `dist/` |
| `start` | `node dist/index.js` | Run the built server (requires `build` first) |
| `dev` | `tsc -w & node --watch dist/index.js` | Watch mode: recompile and restart on changes. **Windows note:** the `&` may not work in cmd/PowerShell; use separate terminals or a tool like `concurrently`. |
| `debug` | `tsc & npx @modelcontextprotocol/inspector node dist/index.js` | Build then launch the MCP Inspector GUI for interactive debugging. Same Windows `&` caveat. |
| `lint` | `eslint src --ext .ts` | Lint TypeScript sources. **Note:** ESLint is not currently configured in this project (no ESLint dependency or config file). This script will fail until ESLint tooling is added. |
| `test` | `echo "Error: no test specified"` | **No tests implemented.** Always exits with code 1. |

### Running in Development Mode

```bash
GOOGLE_API_KEY=your_api_key npm run dev
```

### Project Structure

- `src/index.ts`: Entry point and environment configuration loading
- `src/server.ts`: MCP server implementation
- `src/tools/`: Tool implementations
- `src/services/`: Provider resolution, media helpers, Gemini API, and OpenAI-compatible provider implementation
- `src/types/`: Type definitions
- `src/utils/`: Utility functions

## Gemini Caveats

- **Preview models** (e.g., `gemini-3-flash-preview`) can have tighter rate limits and shorter lifecycles than stable models. Google may deprecate or change them without notice, which could cause fallback attempts to skip to the next model or fail entirely if no stable model is in the chain.
- **Rate limits are per Google Cloud project**, not per API key. Using multiple API keys that share the same project does not increase quota — all keys draw from the same project-level pool.
- **Fallback does not guarantee quota or availability.** If all configured models are rate-limited, unavailable, or unsupported in your region, fallback exhaustion returns an error listing each attempted model and its failure reason.
- **Fallback is Gemini-only.** The OpenAI-compatible provider uses a single model configured via `OPENAI_COMPATIBLE_MODEL` and has no fallback chain. Its behavior is independent of Gemini model configuration.

## Security & Privacy

- **Local file access:** Tools accept arbitrary file paths. The server reads any file the process can access and sends it to the configured provider. Only expose this server to trusted MCP clients.
- **Gemini data transport:** Gemini mode uploads media files to Google's Gemini API servers for processing. Review [Google's Gemini API data governance](https://ai.google.dev/gemini-api/docs/data-governance) for retention and usage policies.
- **OpenAI-compatible data transport:** OpenAI-compatible mode embeds image/video files as base64 data URLs and audio files as raw base64 `input_audio` content parts in `/chat/completions` request bodies. This can increase payload size by roughly one third before HTTP overhead and sends the full media file to the configured provider endpoint.
- **API keys:** `GOOGLE_API_KEY` and `OPENAI_COMPATIBLE_API_KEY` authenticate provider requests. Do not commit them or expose them in logs.
- **Logging:** `LOG_LEVEL=verbose` may print prompts, file details, and provider responses from Gemini paths. The OpenAI-compatible provider does not log API keys or full base64 media payloads. Use verbose/debug logging only for local debugging.
- **No authentication:** In Streamable HTTP mode (selected by `TRANSPORT_TYPE=sse`) the HTTP endpoint has no built-in auth. Anyone who can reach the port can invoke tools and consume provider API quota.

## License

MIT
