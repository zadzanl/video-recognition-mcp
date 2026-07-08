/**
 * Focused Streamable HTTP transport integration tests.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/sdk/types.js';
import { Server } from '../server.js';
import type { ServerConfig } from '../server.js';
import type { ParallelInferenceConfig, ResolvedRecognitionConfig } from '../types/index.js';

type JsonRpcId = string | number | null;

interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id?: JsonRpcId;
  result?: unknown;
  error?: JsonRpcError;
}

interface ToolListResult {
  tools?: { name?: string }[];
}

describe('Server Streamable HTTP transport', () => {
  it('initializes without a session id, returns a session header, and reuses the session for tools/list', async () => {
    const { server, baseUrl } = await startHttpServer();
    const initialize = await postJson(baseUrl, initializeRequest(1));

    try {
      assert.strictEqual(initialize.response.status, 200);
      assertJsonRpcBody(initialize.body);
      assert.strictEqual(initialize.body.error, undefined);
      assert.ok(initialize.body.result);

      const sessionId = initialize.response.headers.get('mcp-session-id');
      assert.ok(sessionId, 'initialize response should include mcp-session-id');

      const initialized = await postJson(baseUrl, initializedNotification(), sessionId);
      assert.strictEqual(initialized.response.status, 202);

      const listTools = await postJson(baseUrl, toolsListRequest(2), sessionId);
      assert.strictEqual(listTools.response.status, 200);
      assertJsonRpcBody(listTools.body);
      assert.strictEqual(listTools.body.error, undefined);

      const result = listTools.body.result as ToolListResult;
      assert.ok(Array.isArray(result.tools));
      assert.deepStrictEqual(
        result.tools.map(tool => tool.name).sort(),
        ['audio_recognition', 'image_recognition', 'video_recognition']
      );

      await server.stop();
      await assert.rejects(fetch(`${baseUrl}/mcp`, {
        method: 'POST',
        headers: httpHeaders(sessionId),
        body: JSON.stringify(toolsListRequest(3)),
        signal: AbortSignal.timeout(2000)
      }));
    } finally {
      await server.stop();
    }
  });

  it('returns JSON-RPC session errors for unknown and missing sessions', async () => {
    const { server, baseUrl } = await startHttpServer();

    try {
      const unknownSession = await postJson(baseUrl, toolsListRequest(1), 'missing-session');
      assert.strictEqual(unknownSession.response.status, 404);
      assertJsonRpcBody(unknownSession.body);
      assert.strictEqual(unknownSession.body.error?.code, -32001);

      const missingSession = await postJson(baseUrl, toolsListRequest(2));
      assert.strictEqual(missingSession.response.status, 400);
      assertJsonRpcBody(missingSession.body);
      assert.strictEqual(missingSession.body.error?.code, -32000);
    } finally {
      await server.stop();
    }
  });

  it('enforces the configured HTTP session limit for new initialize requests', async () => {
    const { server, baseUrl } = await startHttpServer({ maxHttpSessions: 1 });

    try {
      const firstInitialize = await postJson(baseUrl, initializeRequest(1));
      assert.strictEqual(firstInitialize.response.status, 200);
      assert.ok(firstInitialize.response.headers.get('mcp-session-id'));

      const secondInitialize = await postJson(baseUrl, initializeRequest(2));
      assert.strictEqual(secondInitialize.response.status, 503);
      assertJsonRpcBody(secondInitialize.body);
      assert.strictEqual(secondInitialize.body.error?.code, -32000);
    } finally {
      await server.stop();
    }
  });

  it('cleans up a failed initialize attempt before applying the session limit', async () => {
    const { server, baseUrl } = await startHttpServer({ maxHttpSessions: 1 });

    try {
      const failedInitialize = await postJson(baseUrl, malformedInitializeRequest(1));
      assertJsonRpcBody(failedInitialize.body);
      assert.ok(failedInitialize.body.error, 'malformed initialize should return a JSON-RPC error');

      const validInitialize = await postJson(baseUrl, initializeRequest(2));
      assert.strictEqual(validInitialize.response.status, 200);
      assertJsonRpcBody(validInitialize.body);
      assert.strictEqual(validInitialize.body.error, undefined);
      assert.ok(validInitialize.response.headers.get('mcp-session-id'));
    } finally {
      await server.stop();
    }
  });
});

async function startHttpServer(overrides: Partial<ServerConfig> = {}): Promise<{ server: Server; baseUrl: string }> {
  const server = new Server({
    recognition: makeRecognitionConfig(),
    transport: 'sse',
    port: 0,
    ...overrides
  });

  await server.start();

  const port = server.getHttpPort();
  if (port === undefined) {
    throw new Error('HTTP server did not expose a bound port');
  }

  return {
    server,
    baseUrl: `http://127.0.0.1:${port}`
  };
}

async function postJson(
  baseUrl: string,
  payload: Record<string, unknown>,
  sessionId?: string
): Promise<{ response: Response; body: JsonRpcResponse | undefined }> {
  const response = await fetch(`${baseUrl}/mcp`, {
    method: 'POST',
    headers: httpHeaders(sessionId),
    body: JSON.stringify(payload)
  });

  return {
    response,
    body: await readJsonRpcBody(response)
  };
}

async function readJsonRpcBody(response: Response): Promise<JsonRpcResponse | undefined> {
  const text = await response.text();
  if (!text) {
    return undefined;
  }

  const contentType = response.headers.get('content-type') ?? '';
  if (contentType.includes('text/event-stream')) {
    return parseSseJsonRpcBody(text);
  }

  return JSON.parse(text) as JsonRpcResponse;
}

function parseSseJsonRpcBody(text: string): JsonRpcResponse {
  const dataLines = text
    .split(/\r?\n/)
    .filter(line => line.startsWith('data:'))
    .map(line => line.slice('data:'.length).trim())
    .filter(line => line.length > 0);

  const lastDataLine = dataLines[dataLines.length - 1];
  if (!lastDataLine) {
    throw new Error(`SSE response did not contain a data line: ${text}`);
  }

  return JSON.parse(lastDataLine) as JsonRpcResponse;
}

function assertJsonRpcBody(body: JsonRpcResponse | undefined): asserts body is JsonRpcResponse {
  assert.ok(body, 'expected JSON-RPC response body');
}

function httpHeaders(sessionId?: string): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: 'application/json, text/event-stream',
    'Content-Type': 'application/json',
    'Mcp-Protocol-Version': LATEST_PROTOCOL_VERSION
  };

  if (sessionId) {
    headers['Mcp-Session-Id'] = sessionId;
  }

  return headers;
}

function initializeRequest(id: number): Record<string, unknown> {
  return {
    jsonrpc: '2.0',
    id,
    method: 'initialize',
    params: {
      protocolVersion: LATEST_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: {
        name: 'server-transport-test',
        version: '1.0.0'
      }
    }
  };
}

function malformedInitializeRequest(id: number): Record<string, unknown> {
  return {
    jsonrpc: '2.0',
    id,
    method: 'initialize',
    params: {
      capabilities: {},
      clientInfo: {
        name: 'server-transport-test',
        version: '1.0.0'
      }
    }
  };
}

function initializedNotification(): Record<string, unknown> {
  return {
    jsonrpc: '2.0',
    method: 'notifications/initialized',
    params: {}
  };
}

function toolsListRequest(id: number): Record<string, unknown> {
  return {
    jsonrpc: '2.0',
    id,
    method: 'tools/list',
    params: {}
  };
}

function makeRecognitionConfig(): ResolvedRecognitionConfig {
  return {
    provider: 'openai-compatible',
    providerLabel: 'Test OpenAI-Compatible',
    modelName: 'test-model',
    apiKey: 'sk-test',
    baseUrl: 'https://api.example.test/v1',
    maxInlineMediaBytes: 1024,
    parallelInference: makeParallelConfig()
  };
}

function makeParallelConfig(): ParallelInferenceConfig {
  return {
    enabled: false,
    promptCount: 1,
    aggregation: 'all_return',
    promptTemplates: [
      { name: 'Default', suffix: 'Describe the media.' }
    ],
    headerMergeTemplate: '## Summary',
    llmMergePrompt: 'Merge the variants.'
  };
}
