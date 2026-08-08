/**
 * status: active
 * phase: checkpoint-2-transport-characterization
 * sprint: provider-foundation-first-sprint
 * last_modified: 2026-08-02
 * agent_notes: "Pins the target MCP SDK, registration API, and existing stdio/Streamable HTTP-SSE boundary."
 * insights: "The target uses SDK v1 McpServer.tool and StreamableHTTPServerTransport; fork routing and registration files remain absent."
 */

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';

const repositoryRoot = process.cwd();

test('runtime manifest retains the MCP SDK dependency', async () => {
  const manifestText = await readFile(resolve(repositoryRoot, 'package.json'), 'utf8');
  const manifest = JSON.parse(manifestText) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };

  assert.equal(manifest.dependencies?.['@modelcontextprotocol/sdk'], '^1.10.1');
  assert.equal(manifest.devDependencies?.['@modelcontextprotocol/sdk'], undefined);
});

test('server retains McpServer tool registration and stdio/Streamable HTTP-SSE boundaries', async () => {
  const serverSource = await readFile(resolve(repositoryRoot, 'src/server.ts'), 'utf8');

  assert.match(
    serverSource,
    /import \{ McpServer \} from '@modelcontextprotocol\/sdk\/server\/mcp\.js';/
  );
  assert.match(
    serverSource,
    /import \{ StdioServerTransport \} from '@modelcontextprotocol\/sdk\/server\/stdio\.js';/
  );
  assert.match(
    serverSource,
    /import \{ StreamableHTTPServerTransport \} from '@modelcontextprotocol\/sdk\/server\/streamableHttp\.js';/
  );
  assert.equal((serverSource.match(/this\.mcpServer\.tool\(/g) ?? []).length, 3);
  assert.doesNotMatch(serverSource, /registerTool\s*\(/);
  assert.match(serverSource, /new StdioServerTransport\(\)/);
  assert.match(serverSource, /new StreamableHTTPServerTransport\(\{/);
  assert.match(serverSource, /app\.post\('\/mcp'/);
  assert.match(serverSource, /app\.get\('\/mcp'/);
  assert.match(serverSource, /app\.delete\('\/mcp'/);
  assert.match(serverSource, /await this\.mcpServer\.connect\(transport\)/);
});

test('fork registration, routing, parallel, fallback, and authentication additions remain absent', async () => {
  const serverSource = await readFile(resolve(repositoryRoot, 'src/server.ts'), 'utf8');
  const forbiddenServerTokens = [
    'registerTool(',
    'annotations:',
    'parallelDispatcher',
    'recognitionProviders',
    'rateLimitTracker',
    'throttlingScheduler',
    'fallbackProvider',
    'routingPolicy',
    'ctx.mcpReq.signal',
    'Authorization'
  ];

  for (const token of forbiddenServerTokens) {
    assert.equal(serverSource.includes(token), false, `unexpected server token: ${token}`);
  }

  const forbiddenForkFiles = [
    'src/services/parallel-dispatcher.ts',
    'src/services/rate-limit-tracker.ts',
    'src/services/recognition-providers.ts',
    'src/services/throttling-scheduler.ts'
  ];

  for (const relativePath of forbiddenForkFiles) {
    assert.equal(existsSync(resolve(repositoryRoot, relativePath)), false, `unexpected fork file: ${relativePath}`);
  }
});