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
| `GOOGLE_API_KEY` | Gemini API key. Required when provider resolution selects Gemini. |
| `GEMINI_MODEL` | Optional Gemini model. Defaults to `gemini-2.0-flash`. |
| `OPENAI_COMPATIBLE_API_KEY` | API key for the configured OpenAI-compatible endpoint. Required in OpenAI-compatible mode. |
| `OPENAI_COMPATIBLE_BASE_URL` | Base URL for the OpenAI-compatible API, without `/chat/completions`; for example `https://openrouter.ai/api/v1`. |
| `OPENAI_COMPATIBLE_MODEL` | Provider-specific model ID; for example `xiaomi/mimo-v2.5` on OpenRouter or `mimo-v2.5` on Xiaomi MiMo's direct endpoint. |
| `OPENAI_COMPATIBLE_PROVIDER_LABEL` | Optional human-readable provider label used in tool descriptions; for example `OpenRouter`. |
| `MAX_INLINE_MEDIA_BYTES` | Optional maximum local file size for OpenAI-compatible base64 request bodies. Defaults to `20971520` bytes (20 MiB). |

Provider resolution is intentionally conservative:

- If `RECOGNITION_PROVIDER` is set, that provider is used and only that provider's required credentials are validated.
- If `RECOGNITION_PROVIDER` is omitted and only `GOOGLE_API_KEY` is configured, Gemini is used.
- If `RECOGNITION_PROVIDER` is omitted, `GOOGLE_API_KEY` is absent, and a complete OpenAI-compatible config is present, OpenAI-compatible mode is used.
- If both Gemini and OpenAI-compatible config are present and `RECOGNITION_PROVIDER` is omitted, startup fails and asks you to set `RECOGNITION_PROVIDER` explicitly.

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

## Security & Privacy

- **Local file access:** Tools accept arbitrary file paths. The server reads any file the process can access and sends it to the configured provider. Only expose this server to trusted MCP clients.
- **Gemini data transport:** Gemini mode uploads media files to Google's Gemini API servers for processing. Review [Google's Gemini API data governance](https://ai.google.dev/gemini-api/docs/data-governance) for retention and usage policies.
- **OpenAI-compatible data transport:** OpenAI-compatible mode embeds image/video files as base64 data URLs and audio files as raw base64 `input_audio` content parts in `/chat/completions` request bodies. This can increase payload size by roughly one third before HTTP overhead and sends the full media file to the configured provider endpoint.
- **API keys:** `GOOGLE_API_KEY` and `OPENAI_COMPATIBLE_API_KEY` authenticate provider requests. Do not commit them or expose them in logs.
- **Logging:** `LOG_LEVEL=verbose` may print prompts, file details, and provider responses from Gemini paths. The OpenAI-compatible provider does not log API keys or full base64 media payloads. Use verbose/debug logging only for local debugging.
- **No authentication:** In Streamable HTTP mode (selected by `TRANSPORT_TYPE=sse`) the HTTP endpoint has no built-in auth. Anyone who can reach the port can invoke tools and consume provider API quota.

## License

MIT
