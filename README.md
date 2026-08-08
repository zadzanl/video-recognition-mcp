# MCP Video Recognition Server

An MCP server that describes images, transcribes audio, and summarizes video from local files. It uses Google Gemini by default, or any OpenAI-compatible endpoint such as OpenRouter.

<a href="https://glama.ai/mcp/servers/@mario-andreschak/mcp_video_recognition">
  <img width="380" height="200" src="https://glama.ai/mcp/servers/@mario-andreschak/mcp_video_recognition/badge" alt="Video Recognition Server MCP server" />
</a>

## Features

- Pick your provider: Google Gemini (default) or an OpenAI-compatible endpoint
- Three MCP tools for local images, audio, and video
- Optional Gemini model fallback, plus a final OpenAI-compatible backup

Model support varies. Choosing the OpenAI-compatible provider does not mean every endpoint or model handles every media type, and the server never substitutes a model or provider for you.

## Prerequisites

- Node.js **18.0.0 or later**
- An API key for your provider:
  - Gemini: `GOOGLE_API_KEY`
  - OpenAI-compatible: `OPENAI_COMPATIBLE_API_KEY`

## Install

```bash
git clone https://github.com/yourusername/mcp-video-recognition.git
cd mcp-video-recognition
npm install
npm run build
```

## Quickstart

Add the server to your MCP client config and point it at the built `dist/index.js`:

```json
{
  "mcpServers": {
    "video-recognition": {
      "command": "node",
      "args": ["/path/to/mcp-video-recognition/dist/index.js"],
      "env": {
        "GOOGLE_API_KEY": "your_google_api_key"
      }
    }
  }
}
```

On Windows, use forward slashes or doubled backslashes (`\\`) in the path. Save the file and reconnect your MCP client.

For OpenRouter or another OpenAI-compatible endpoint, set `RECOGNITION_PROVIDER=openai-compatible` plus its variables. See [Configuration](docs/CONFIGURATION.md) for a ready-made example.

<details>
<summary>Other install options (FLUJO)</summary>

With [FLUJO](https://github.com/mario-andreschak/FLUJO/):

1. Click **Add Server**.
2. Paste the GitHub URL.
3. Click **Parse, Clone, Install, Build and Save**.

</details>

## Configuration

The server reads environment variables. The most common ones:

| Variable | Default | Purpose |
|---|---|---|
| `RECOGNITION_PROVIDER` | `gemini` | `gemini` or `openai-compatible` |
| `GOOGLE_API_KEY` | none | Gemini API key |
| `GEMINI_MODEL` | `gemini-3.5-flash` | Gemini model to use |
| `OPENAI_COMPATIBLE_API_KEY` | none | OpenAI-compatible API key |
| `OPENAI_COMPATIBLE_BASE_URL` | none | Endpoint base URL |
| `OPENAI_COMPATIBLE_MODEL` | xiaomi/mimo-v2.5 | Model to use |
| `ALLOWED_MEDIA_ROOTS` | none | Media directories for the OpenAI-compatible provider and Gemini backup |

Bad values stop startup; they are not fixed silently.

For the full variable list, validation rules, the OpenRouter example, and supported media types, see the **[Configuration Reference](docs/CONFIGURATION.md)**.

For Gemini model fallback and the final backup, see the **[Provider Recovery Reference](docs/RECOVERY.md)**.

## Tools

The server provides three MCP tools. Each takes a local `filepath`, an optional `prompt` (default `Describe this content`), and an optional `modelname` override.

- `image_recognition` — describe an image
- `audio_recognition` — transcribe or describe audio
- `video_recognition` — describe a video

Example:

```json
{
  "name": "video_recognition",
  "arguments": {
    "filepath": "/path/to/video.mp4",
    "prompt": "Describe what happens in this video"
  }
}
```

## Security

- HTTPS is required by default. Plain HTTP is allowed only for an explicitly enabled local endpoint.
- The OpenAI-compatible provider and Gemini backup read media only from directories you list in `ALLOWED_MEDIA_ROOTS`.
- Keys stay in the process environment. Do not commit real keys.

For endpoint rules, resource limits, and incident response, see the **[Security Reference](docs/SECURITY.md)**.

## Development

```bash
# Run in development mode
GOOGLE_API_KEY=your_api_key npm run dev

# Build and run the provider foundation tests
npm run verify:provider-foundation
```

### Project Structure

- `src/index.ts`: entry point and provider construction
- `src/server.ts`: MCP server and transport
- `src/tools/`: the three recognition tools
- `src/services/`: Gemini and OpenAI-compatible providers
- `src/types/`: shared types
- `src/utils/`: helpers

## License

MIT
