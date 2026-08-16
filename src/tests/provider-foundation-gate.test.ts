/**
 * status: active
 * phase: change-b-group-1a
 * sprint: gemini-model-fallback-and-rate-limit-recovery
 * last_modified: 2026-08-07
 * agent_notes: "Machine-readable proof that an incompatible provider implementation fails local TypeScript compilation."
 * insights: "The gate invokes the repository-local compiler directly and cleans up its temporary TypeScript input."
 */

import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

test('broken provider contract fixture exits nonzero under the local TypeScript compiler', async () => {
  const fixturesDirectory = path.resolve(process.cwd(), 'src/tests/fixtures');
  const temporaryDirectory = await mkdtemp(path.join(fixturesDirectory, '.provider-foundation-'));
  const fixturePath = path.join(fixturesDirectory, 'broken-provider-contract.ts.fixture');
  const materializedPath = path.join(temporaryDirectory, 'broken-provider-contract.ts');

  try {
    await writeFile(materializedPath, await readFile(fixturePath, 'utf8'));
    const compilerPath = path.resolve(process.cwd(), 'node_modules/typescript/bin/tsc');
    const result = spawnSync(process.execPath, [
      compilerPath,
      '--noEmit',
      '--strict',
      '--target', 'ES2022',
      '--module', 'NodeNext',
      '--moduleResolution', 'NodeNext',
      materializedPath
    ], { encoding: 'utf8' });

    assert.equal(result.error, undefined, 'local TypeScript compiler must execute');
    assert.notEqual(result.status, 0, 'broken provider contract unexpectedly compiled');
    assert.match(`${result.stdout}${result.stderr}`, /RecognitionResult|isError/u);
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});